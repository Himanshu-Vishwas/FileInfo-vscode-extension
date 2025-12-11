import * as vscode from 'vscode';
import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as path from 'path';

let lastUri: vscode.Uri | undefined;
let lastAutoUri: string | undefined;
let updateTimeout: NodeJS.Timeout | undefined;

export function activate(context: vscode.ExtensionContext) {
  const statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusBar.tooltip = 'FileInfo: no file selected';
  statusBar.text = '📄 No file selected';
  statusBar.command = 'fileinfo.showActions';
  statusBar.show();
  context.subscriptions.push(statusBar);

  const out = vscode.window.createOutputChannel('FileInfo');
  context.subscriptions.push(out);

  const formatSize = (bytes: number) => {
    if (bytes === 0) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
    const value = bytes / Math.pow(1024, i);
    const decimals = value < 10 && i > 0 ? 3 : 1;
    return `${value.toFixed(decimals)} ${units[i]}`;
  };

  const readStats = async (filePath: string): Promise<fs.Stats | null> => {
    try {
      return await fsp.stat(filePath);
    } catch {
      return null;
    }
  };

  const getImmediateCounts = async (folderPath: string) => {
    try {
      const entries = await fsp.readdir(folderPath, { withFileTypes: true });
      let files = 0, dirs = 0;
      for (const e of entries) {
        if (e.isFile()) files++;
        else if (e.isDirectory()) dirs++;
      }
      return { files, dirs };
    } catch {
      return { files: 0, dirs: 0 };
    }
  };

  // Main status bar update logic
  const updateStatus = async (uri?: vscode.Uri) => {
    if (!uri || uri.scheme !== 'file') {
      statusBar.text = '📄 No file selected';
      statusBar.tooltip = 'Select a file or folder in Explorer, or open a file';
      lastUri = undefined;
      return;
    }

    lastUri = uri;
    const filePath = uri.fsPath;
    let base = path.basename(filePath);
    if (base.length > 30) {
      base = base.substring(0, 29) + '…';
    }
    const stats = await readStats(filePath);

    if (!stats) {
      statusBar.text = `⚠️ ${base}`;
      statusBar.tooltip = `Cannot access: ${filePath}`;
      return;
    }

    const isFile = stats.isFile();
    const isDir = stats.isDirectory();
    const sizeText = isFile ? formatSize(stats.size) : '—';

    statusBar.text = isFile ? `📄 ${base} (${sizeText})` : `📁 ${base}`;

    const ext = isFile ? path.extname(base) || '—' : '—';
    const created = stats.birthtime?.toLocaleString() ?? '—';
    const modified = stats.mtime.toLocaleString();
    const accessed = stats.atime.toLocaleString();

    statusBar.tooltip = [
      `Path: ${filePath}`,
      `Name: ${base}`,
      `Extension: ${ext}`,
      `Size: ${isFile ? `${sizeText} (${stats.size} bytes)` : '—'}`,
      `Created: ${created}`,
      `Modified: ${modified}`,
      `Accessed: ${accessed}`
    ].join('\n');
  };

  // Robust detection of selected file/folder (works for images, folders, binaries, etc.)
  const triggerUpdate = () => {
    if (updateTimeout) clearTimeout(updateTimeout);
    updateTimeout = setTimeout(async () => {
      // 1. Check active tab (covers custom editors like images, hex views, etc.)
      const activeTab = vscode.window.tabGroups.activeTabGroup.activeTab;
      if (activeTab) {
        const input = activeTab.input;
        if (input instanceof vscode.TabInputText || input instanceof vscode.TabInputCustom || input instanceof vscode.TabInputNotebook) {
          if (input.uri.scheme === 'file') {
            if (input.uri.toString() !== lastAutoUri) {
              lastAutoUri = input.uri.toString();
              await updateStatus(input.uri);
            }
            return;
          }
        }
      }

      // 2. Active text editor (fallback)
      const activeEditor = vscode.window.activeTextEditor;
      if (activeEditor?.document?.uri?.scheme === 'file') {
        if (activeEditor.document.uri.toString() !== lastAutoUri) {
          lastAutoUri = activeEditor.document.uri.toString();
          await updateStatus(activeEditor.document.uri);
        }
        return;
      }

      // 3. Any visible editor
      for (const editor of vscode.window.visibleTextEditors) {
        if (editor.document.uri.scheme === 'file') {
          const uri = editor.document.uri;
          if (uri.toString() !== lastAutoUri) {
            lastAutoUri = uri.toString();
            await updateStatus(uri);
          }
          return;
        }
      }

      // 4. Nothing selected
      if (lastAutoUri !== undefined) {
        lastAutoUri = undefined;
        await updateStatus(undefined);
      }
    }, 100); // small debounce
  };

  // Register all relevant events
  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor(triggerUpdate),
    vscode.window.onDidChangeVisibleTextEditors(triggerUpdate),
    vscode.window.tabGroups.onDidChangeTabs(triggerUpdate),
    vscode.workspace.onDidOpenTextDocument(triggerUpdate),
    vscode.window.onDidChangeWindowState(e => e.focused && triggerUpdate())
  );

  // Initial update
  setTimeout(triggerUpdate, 500);

  // Image metadata reader
  async function readImageMetadata(filePath: string): Promise<{ format: string; width: number; height: number; channels: number; density?: { x: number; y: number; units: 'dpi' | 'ppi' } } | null> {
    try {
      const fh = await fsp.open(filePath, 'r');
      const buffer = Buffer.alloc(65536);
      const { bytesRead } = await fh.read(buffer, 0, 65536, 0);
      await fh.close();
      if (bytesRead < 12) return null;

      // PNG
      if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4E && buffer[3] === 0x47 && bytesRead >= 24) {
        const width = buffer.readUInt32BE(16);
        const height = buffer.readUInt32BE(20);
        const colorType = buffer[25];
        const channels = [0, 1, 3, 1, 2, 0, 4][colorType] || 3;

        // Search for pHYs chunk
        let offset = 8; // Skip signature
        let density: { x: number; y: number; units: 'dpi' | 'ppi' } | undefined;

        while (offset < bytesRead - 8) {
          const length = buffer.readUInt32BE(offset);
          const type = buffer.toString('ascii', offset + 4, offset + 8);

          if (type === 'pHYs' && length >= 9) {
            const ppuX = buffer.readUInt32BE(offset + 8);
            const ppuY = buffer.readUInt32BE(offset + 12);
            const unit = buffer[offset + 16];

            if (unit === 1) { // Meter
              // Convert pixels per meter to pixels per inch (1 inch = 0.0254 meters)
              const ppiX = Math.round(ppuX * 0.0254);
              const ppiY = Math.round(ppuY * 0.0254);
              density = { x: ppiX, y: ppiY, units: 'ppi' };
            }
            break;
          }

          offset += 12 + length; // Length + Type + Data + CRC
        }

        return { format: 'PNG', width, height, channels, density };
      }

      // JPEG
      if (buffer[0] === 0xFF && buffer[1] === 0xD8) {
        let i = 2;
        let density: { x: number; y: number; units: 'dpi' | 'ppi' } | undefined;
        let width = 0, height = 0, channels = 3;

        // Check APP0 for density
        if (buffer[2] === 0xFF && buffer[3] === 0xE0) {
          const length = buffer.readUInt16BE(4);
          const identifier = buffer.toString('ascii', 6, 10);
          if (identifier === 'JFIF' && length >= 14) {
            const units = buffer[13];
            const xDensity = buffer.readUInt16BE(14);
            const yDensity = buffer.readUInt16BE(16);

            if (units === 1) { // Dots per inch
              density = { x: xDensity, y: yDensity, units: 'dpi' };
            } else if (units === 2) { // Dots per cm
              density = { x: Math.round(xDensity * 2.54), y: Math.round(yDensity * 2.54), units: 'dpi' };
            }
          }
        }

        while (i < bytesRead - 9) {
          if (buffer[i] !== 0xFF) { i++; continue; }
          const marker = buffer[i + 1];
          if (marker === 0xFF) { i++; continue; }
          if (marker >= 0xC0 && marker <= 0xCF && marker !== 0xC4 && marker !== 0xC8 && marker !== 0xCC) {
            height = buffer.readUInt16BE(i + 5);
            width = buffer.readUInt16BE(i + 7);
            channels = buffer[i + 9] || 3;
            return { format: 'JPEG', width, height, channels, density };
          }
          i += 2 + buffer.readUInt16BE(i + 2);
        }
        return null;
      }

      // BMP
      if (buffer[0] === 0x42 && buffer[1] === 0x4D && bytesRead >= 30) {
        const width = buffer.readInt32LE(18);
        const height = Math.abs(buffer.readInt32LE(22));
        const bpp = buffer.readUInt16LE(28);
        const channels = Math.max(1, Math.floor(bpp / 8));

        // Extract resolution from BITMAPINFOHEADER
        // XPelsPerMeter is at offset 24 (from header start) -> 14 + 24 = 38
        // YPelsPerMeter is at offset 28 (from header start) -> 14 + 28 = 42
        let density: { x: number; y: number; units: 'dpi' | 'ppi' } | undefined;

        if (bytesRead >= 46) {
          const xPPM = buffer.readInt32LE(38);
          const yPPM = buffer.readInt32LE(42);
          if (xPPM > 0 && yPPM > 0) {
            const ppiX = Math.round(xPPM * 0.0254);
            const ppiY = Math.round(yPPM * 0.0254);
            density = { x: ppiX, y: ppiY, units: 'ppi' };
          }
        }

        return { format: 'BMP', width, height, channels, density };
      }

      // GIF
      if (buffer.toString('ascii', 0, 6).match(/^GIF(87a|89a)/) && bytesRead >= 10) {
        const width = buffer.readUInt16LE(6);
        const height = buffer.readUInt16LE(8);
        return { format: 'GIF', width, height, channels: 1 };
      }

      return null;
    } catch {
      return null;
    }
  }

  async function readCsvMetadata(filePath: string): Promise<{ rows: number; columns: number; headers: string[]; firstRow: string[] } | null> {
    try {
      // 1. Count rows efficiently using streams
      let rows = 0;
      const stream = fs.createReadStream(filePath);
      for await (const chunk of stream) {
        for (const char of chunk) {
          if (char === 10) rows++; // Count \n
        }
      }
      // If file is not empty and doesn't end with newline, add 1 (or if it's just one line)
      // A simple heuristic: if size > 0, we have at least 1 line.
      // But counting \n is the standard way. If the last line has no \n, we might miss it.
      // Let's refine: usually CSVs have \n.
      // Better approach for exact CSV row count is complex without a parser, but counting \n is a good approximation for "lines".
      // We'll adjust if the file size > 0 and rows == 0, it's 1.

      // Re-read for content parsing (just the beginning)
      const fh = await fsp.open(filePath, 'r');
      const buffer = Buffer.alloc(4096); // Read 4KB
      const { bytesRead } = await fh.read(buffer, 0, 4096, 0);
      await fh.close();

      if (bytesRead === 0) return { rows: 0, columns: 0, headers: [], firstRow: [] };

      const content = buffer.toString('utf8', 0, bytesRead);
      const lines = content.split(/\r?\n/);

      if (lines.length === 0) return null;

      // Simple CSV parser for the first two lines
      // Handles basic comma separation. Does NOT handle quoted commas for simplicity unless requested.
      // User asked for "no of columns, no of rows and column names and first row values"

      const parseLine = (line: string) => line.split(',').map(s => s.trim());

      const headers = parseLine(lines[0]);
      const firstRow = lines.length > 1 && lines[1].trim() !== '' ? parseLine(lines[1]) : [];

      // Adjust row count: The stream counted newlines. 
      // If the file doesn't end in newline, the count is one less than lines.
      // We can just use the stream count as "Total Lines".
      // But typically "rows" in CSV implies data rows. 
      // Let's return "Total Lines" as rows for now, or "Data Rows" = Total - 1 (header).
      // Let's stick to "Total Rows" (lines) for simplicity in "File Info".

      // Correction for last line without newline
      const stats = await fsp.stat(filePath);
      if (stats.size > 0) {
        const fh = await fsp.open(filePath, 'r');
        const buffer = Buffer.alloc(1);
        const { bytesRead } = await fh.read(buffer, 0, 1, stats.size - 1);
        await fh.close();
        if (bytesRead > 0 && buffer[0] !== 10) {
          rows++;
        }
      }

      return { rows, columns: headers.length, headers, firstRow };
    } catch {
      return null;
    }
  }

  const showDetailsModal = async (uri: vscode.Uri) => {
    if (!uri || uri.scheme !== 'file') {
      vscode.window.showInformationMessage('FileInfo: No file or folder selected');
      return;
    }

    const filePath = uri.fsPath;
    const base = path.basename(filePath);
    const extName = path.extname(base);
    const typeLabel = extName ? extName.substring(1).toUpperCase() : 'File';

    // Show loading state
    statusBar.text = `$(sync~spin) Reading ${typeLabel} details...`;
    statusBar.tooltip = `Reading ${typeLabel} metadata...`;

    try {
      const stats = await readStats(filePath);

      const lines: string[] = [];
      lines.push(`Path: ${filePath}`);
      lines.push(`Name: ${base}`);

      if (!stats) {
        const pick = await vscode.window.showInformationMessage(
          `Folder: ${base}\n(Cannot read contents)`,
          { modal: true },
          'Copy path', 'Close'
        );
        if (pick === 'Copy path') {
          await vscode.env.clipboard.writeText(filePath);
          vscode.window.showInformationMessage('Path copied');
        }
        return;
      }

      const isFile = stats.isFile();
      const isDir = stats.isDirectory();
      const ext = isFile ? (path.extname(base).toLowerCase() || '—') : '—';
      const sizeText = isFile ? `${formatSize(stats.size)} (${stats.size} bytes)` : '—';

      lines.push(`Extension: ${ext}`);
      lines.push(`Size: ${sizeText}`);
      if (isDir) {
        const { files, dirs } = await getImmediateCounts(filePath);
        lines.push(`Direct children: ${files} files, ${dirs} folders`);
      }
      lines.push(`Created: ${stats.birthtime?.toLocaleString() ?? '—'}`);
      lines.push(`Modified: ${stats.mtime.toLocaleString()}`);
      lines.push(`Accessed: ${stats.atime.toLocaleString()}`);

      if (isFile) {
        const imageExts = ['.png', '.jpg', '.jpeg', '.bmp', '.gif'];
        if (imageExts.includes(ext)) {
          const meta = await readImageMetadata(filePath);
          if (meta) {
            lines.push(`Image Info:`);
            lines.push(`  Format: ${meta.format}`);
            lines.push(`  Dimensions: ${meta.width}×${meta.height}px`);
            lines.push(`  Channels: ${meta.channels}`);
            if (meta.density) {
              const { x, y, units } = meta.density;
              const densityStr = x === y ? `${x} ${units.toUpperCase()}` : `${x}x${y} ${units.toUpperCase()}`;
              lines.push(`  Resolution: ${densityStr}`);
            }
          }
        } else if (ext === '.csv') {
          const csv = await readCsvMetadata(filePath);
          if (csv) {
            lines.push(`CSV Info:`);
            lines.push(`  Rows: ${csv.rows}`);
            lines.push(`  Columns: ${csv.columns}`);
            lines.push(`  Headers: ${csv.headers.join(', ')}`);
            if (csv.firstRow.length > 0) {
              lines.push(`  First Row: ${csv.firstRow.join(', ')}`);
            }
          }
        }
      }

      const message = lines.join('\n');

      // Restore status before showing modal so it doesn't look stuck if modal is open
      await updateStatus(uri);

      const pick = await vscode.window.showInformationMessage(message, { modal: true }, 'Copy details', 'Copy path', 'Close');

      if (pick === 'Copy details') {
        try {
          const doc = await vscode.workspace.openTextDocument({ content: message, language: 'text' });
          await vscode.window.showTextDocument(doc, { preview: true });
        } catch {
          await vscode.env.clipboard.writeText(message);
          vscode.window.showInformationMessage('Details copied to clipboard');
        }
      } else if (pick === 'Copy path') {
        await vscode.env.clipboard.writeText(filePath);
        vscode.window.showInformationMessage('Path copied');
      }
    } finally {
      // Ensure status is restored even if error occurs
      if (lastUri && lastUri.toString() === uri.toString()) {
        await updateStatus(uri);
      } else {
        // If selection changed or something else, just trigger generic update
        triggerUpdate();
      }
    }
  };

  // Commands
  context.subscriptions.push(
    vscode.commands.registerCommand('fileinfo.showInfo', async (uri?: vscode.Uri) => {
      if (!uri) {
        // Try to get from active tab first (supports images/custom editors)
        const activeTab = vscode.window.tabGroups.activeTabGroup.activeTab;
        if (activeTab) {
          const input = activeTab.input;
          if (input instanceof vscode.TabInputText || input instanceof vscode.TabInputCustom || input instanceof vscode.TabInputNotebook) {
            uri = input.uri;
          }
        }
      }

      if (!uri) {
        uri = vscode.window.activeTextEditor?.document.uri;
      }
      if (!uri) {
        const editors = vscode.window.visibleTextEditors;
        if (editors.length > 0) {
          uri = editors[0].document.uri;
        }
      }
      if (!uri) {
        vscode.window.showInformationMessage('FileInfo: No file selected');
        return;
      }
      if (uri.scheme === 'file') {
        await updateStatus(uri);
      }
      await showDetailsModal(uri);
    }),

    vscode.commands.registerCommand('fileinfo.showActions', async () => {
      if (!lastUri) {
        vscode.window.showInformationMessage('No file selected. Click a file/folder in Explorer or open a file.');
        return;
      }
      const filePath = lastUri.fsPath;
      const items = [
        { label: '$(info) Show full details', description: 'Detailed metadata' },
        { label: '$(clippy) Copy path', description: 'Copy full path' },
        { label: 'Cancel' }
      ];
      const pick = await vscode.window.showQuickPick(items, { placeHolder: `Actions for ${path.basename(filePath)}` });
      if (pick?.label.includes('Show full details')) {
        await showDetailsModal(lastUri);
      } else if (pick?.label.includes('Copy path')) {
        await vscode.env.clipboard.writeText(filePath);
        vscode.window.showInformationMessage('Path copied');
      }
    }),

    vscode.commands.registerCommand('fileinfo.showInfoFromStatus', async () => {
      if (lastUri) {
        await showDetailsModal(lastUri);
      } else {
        vscode.window.showInformationMessage('FileInfo: No file selected');
      }
    })
  );

  // Final initial trigger
  triggerUpdate();
}

export function deactivate() { }