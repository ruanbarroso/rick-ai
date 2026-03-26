/**
 * Shared text rendering utilities for all viewer pages.
 * Converts plain text with markdown-like syntax to HTML.
 *
 * Usage:
 *   <script src="/static/render-text.js"></script>
 *   renderText('hello **bold** world')  => 'hello <strong>bold</strong> world'
 *
 * Also exports: escapeHtml(), renderMessageContent(), getFileIcon(), getFileTypeLabel(),
 *               openImageFullscreen(), closeImageFullscreen()
 */

// eslint-disable-next-line no-unused-vars
function escapeHtml(str) {
  if (!str) return '';
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// eslint-disable-next-line no-unused-vars
function renderText(text) {
  if (!text) return '';

  text = text.trim();

  // 1. Escape HTML
  var escaped = text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

  // 2. Extract code blocks (replace with placeholder to avoid processing internals)
  var codeBlocks = [];
  escaped = escaped.replace(/```(\w*)\n?([\s\S]*?)```/g, function(_, lang, code) {
    var langLabel = lang ? '<span class="code-lang">' + lang + '</span>' : '';
    var block = '<pre>' + langLabel + '<code>' + code.trim() + '</code></pre>';
    codeBlocks.push(block);
    return '\x00CB' + (codeBlocks.length - 1) + '\x00';
  });

  // 3. Inline code
  escaped = escaped.replace(/`([^`\n]+)`/g, '<code>$1</code>');

  // 4. Inline formatting (must run BEFORE URL linkification so that
  //    **https://...** is converted to <strong>https://...</strong> first,
  //    preventing the URL regex from swallowing trailing asterisks)
  function inlineFmtEarly(t) {
    // Bold (**...**)
    t = t.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
    // Italic (*...*) — single asterisk
    t = t.replace(/(?<!\*)\*([^*\n]+)\*(?!\*)/g, '<em>$1</em>');
    // Italic (_..._) — only when underscores are NOT inside a word (GFM behavior)
    t = t.replace(/(?<![_\w])_([^_\n]+)_(?![_\w])/g, '<em>$1</em>');
    // Strikethrough (~~...~~)
    t = t.replace(/~~([^~\n]+)~~/g, '<del>$1</del>');
    return t;
  }
  escaped = inlineFmtEarly(escaped);

  // 5. Clickable URLs (runs after inline formatting so bold/italic markers are already consumed)
  //    Uses a greedy match then strips trailing punctuation that is likely not part of the URL.
  escaped = escaped.replace(/(https?:\/\/(?:[^\s<>]|&amp;)+)/g, function(match) {
    // Strip trailing punctuation/markdown artifacts that got captured
    var url = match.replace(/(?:[.,;:!?)>\]]+|&lt;|&gt;)+$/, '');
    var trailing = match.slice(url.length);
    return '<a href="' + url + '" target="_blank" rel="noopener">' + url + '</a>' + trailing;
  });

  // 6. Line-by-line processing (headers, lists, hr)
  function inlineFmt(t) {
    // Bold (**...**)
    t = t.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
    // Italic (*...*) — single asterisk = italic
    t = t.replace(/(?<!\*)\*([^*\n]+)\*(?!\*)/g, '<em>$1</em>');
    // Italic (_..._) — only when underscores are NOT inside a word (GFM behavior)
    t = t.replace(/(?<![_\w])_([^_\n]+)_(?![_\w])/g, '<em>$1</em>');
    // Strikethrough (~~...~~)
    t = t.replace(/~~([^~\n]+)~~/g, '<del>$1</del>');
    return t;
  }

  var lines = escaped.split('\n');
  var result = [];
  var inList = false;
  var listType = null;

  function closeList() {
    if (inList) { result.push('</' + listType + '>'); inList = false; listType = null; }
  }

  // Helper: check if a line is a markdown table row (starts and ends with |, or starts with |)
  function isTableRow(ln) {
    return /^\|.+\|/.test(ln.trim());
  }

  // Helper: check if a line is a table separator (|---|---|)
  function isTableSeparator(ln) {
    return /^\|[\s\-:]+(\|[\s\-:]+)*\|?\s*$/.test(ln.trim());
  }

  // Helper: parse a table row into cells
  function parseTableCells(ln) {
    var trimmed = ln.trim();
    // Remove leading/trailing pipes
    if (trimmed.charAt(0) === '|') trimmed = trimmed.substring(1);
    if (trimmed.charAt(trimmed.length - 1) === '|') trimmed = trimmed.substring(0, trimmed.length - 1);
    return trimmed.split('|').map(function(cell) { return cell.trim(); });
  }

  // Helper: render a group of table lines into HTML
  function renderTable(tableLines) {
    if (tableLines.length < 2) {
      // Not enough lines for a table — render as plain text
      for (var t = 0; t < tableLines.length; t++) {
        result.push(inlineFmt(tableLines[t]) + '<br>');
      }
      return;
    }

    var headerLine = tableLines[0];
    var separatorIdx = -1;
    // Find the separator line (usually line 1)
    for (var s = 1; s < tableLines.length && s <= 2; s++) {
      if (isTableSeparator(tableLines[s])) { separatorIdx = s; break; }
    }

    var hasHeader = separatorIdx > 0;
    var headerCells = hasHeader ? parseTableCells(headerLine) : [];
    var dataStart = hasHeader ? separatorIdx + 1 : 0;

    result.push('<div class="table-wrapper"><table>');
    if (hasHeader) {
      result.push('<thead><tr>');
      for (var h = 0; h < headerCells.length; h++) {
        result.push('<th>' + inlineFmt(headerCells[h]) + '</th>');
      }
      result.push('</tr></thead>');
    }
    result.push('<tbody>');
    for (var r = dataStart; r < tableLines.length; r++) {
      if (isTableSeparator(tableLines[r])) continue; // skip extra separators
      var cells = parseTableCells(tableLines[r]);
      result.push('<tr>');
      for (var c = 0; c < cells.length; c++) {
        result.push('<td>' + inlineFmt(cells[c]) + '</td>');
      }
      result.push('</tr>');
    }
    result.push('</tbody></table></div>');
  }

  for (var i = 0; i < lines.length; i++) {
    var line = lines[i];

    // Code block placeholder
    if (/\x00CB\d+\x00/.test(line)) {
      closeList();
      result.push(line.replace(/\x00CB(\d+)\x00/g, function(_, idx) { return codeBlocks[+idx]; }));
      continue;
    }

    // Markdown table: collect consecutive table rows
    if (isTableRow(line)) {
      closeList();
      var tableLines = [line];
      while (i + 1 < lines.length && (isTableRow(lines[i + 1]) || isTableSeparator(lines[i + 1]))) {
        i++;
        tableLines.push(lines[i]);
      }
      renderTable(tableLines);
      continue;
    }

    // Horizontal rule (--- / *** / ___)
    if (/^(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      closeList();
      result.push('<hr>');
      continue;
    }

    // Headings (# ## ###)
    var hm = line.match(/^(#{1,3})\s+(.+)$/);
    if (hm) {
      closeList();
      var lvl = hm[1].length;
      result.push('<h' + lvl + '>' + inlineFmt(hm[2]) + '</h' + lvl + '>');
      continue;
    }

    // Unordered list (- / * / +)
    var ulm = line.match(/^[\-\*\+]\s+(.+)$/);
    if (ulm) {
      if (!inList || listType !== 'ul') { closeList(); result.push('<ul>'); inList = true; listType = 'ul'; }
      result.push('<li>' + inlineFmt(ulm[1]) + '</li>');
      continue;
    }

    // Ordered list (1. 2. ...)
    var olm = line.match(/^\d+\.\s+(.+)$/);
    if (olm) {
      if (!inList || listType !== 'ol') { closeList(); result.push('<ol>'); inList = true; listType = 'ol'; }
      result.push('<li>' + inlineFmt(olm[1]) + '</li>');
      continue;
    }

    // Empty line
    if (line.trim() === '') {
      closeList();
      result.push('<br>');
      continue;
    }

    closeList();
    result.push(inlineFmt(line) + '<br>');
  }

  closeList();

  var finalHtml = result.join('');
  // Remove trailing and leading <br>s
  finalHtml = finalHtml.replace(/^(<br>\s*)+/, '').replace(/(<br>\s*)+$/, '');
  return finalHtml;
}

// ==================== MEDIA RENDERING ====================

// eslint-disable-next-line no-unused-vars
function getFileIcon(mimeType) {
  if (!mimeType) return '\uD83D\uDCC4';
  if (mimeType.startsWith('text/')) return '\uD83D\uDCDD';
  if (mimeType === 'application/pdf') return '\uD83D\uDCD5';
  if (mimeType === 'application/json') return '\uD83D\uDCCB';
  if (mimeType === 'application/xml' || mimeType === 'text/xml') return '\uD83D\uDCCB';
  if (mimeType === 'application/javascript' || mimeType === 'text/javascript') return '\uD83D\uDCDC';
  if (mimeType.startsWith('application/zip') || mimeType.includes('compressed') || mimeType.includes('zip')) return '\uD83D\uDDDC\uFE0F';
  if (mimeType.startsWith('application/vnd.ms-excel') || mimeType.includes('spreadsheet')) return '\uD83D\uDCCA';
  if (mimeType.startsWith('application/vnd.ms-powerpoint') || mimeType.includes('presentation')) return '\uD83D\uDCCA';
  if (mimeType.startsWith('application/msword') || mimeType.includes('wordprocessing')) return '\uD83D\uDCDD';
  if (mimeType.startsWith('video/')) return '\uD83C\uDFAC';
  return '\uD83D\uDCCE';
}

// eslint-disable-next-line no-unused-vars
function getFileTypeLabel(mimeType) {
  if (!mimeType) return 'Arquivo';
  if (mimeType === 'text/plain') return 'Texto';
  if (mimeType === 'text/csv') return 'CSV';
  if (mimeType === 'text/html') return 'HTML';
  if (mimeType === 'application/pdf') return 'PDF';
  if (mimeType === 'application/json') return 'JSON';
  if (mimeType === 'application/xml' || mimeType === 'text/xml') return 'XML';
  if (mimeType === 'application/javascript' || mimeType === 'text/javascript') return 'JavaScript';
  var parts = mimeType.split('/');
  return parts[1] ? parts[1].toUpperCase().substring(0, 10) : 'Arquivo';
}

/**
 * Renders a message with optional media attachments (images, audio, files).
 * Falls back to renderText() when no media is present.
 */
// eslint-disable-next-line no-unused-vars
function renderMessageContent(text, audioUrl, imageUrls, fileInfos) {
  var html = '';
  var hasImages = imageUrls && imageUrls.length > 0;
  var hasFileInfos = fileInfos && fileInfos.length > 0;

  var displayText = text;
  if (hasFileInfos && displayText) {
    displayText = displayText.replace(/\n\n\[Conte\u00FAdo do arquivo "[^"]*"\]:[\s\S]*/g, '').trim();
  }

  var remainingText = displayText || '';
  var audioTranscription = null;

  if (audioUrl && remainingText) {
    var transcriptionTag = remainingText.match(/\n?\[\u00C1udio transcrito:\s*"([\s\S]+?)"\]\s*$/i)
      || remainingText.match(/\n?\[\u00C1udio transcrito\]:\s*([\s\S]+)$/i);
    if (transcriptionTag) {
      audioTranscription = (transcriptionTag[1] || '').trim();
      remainingText = remainingText.replace(transcriptionTag[0], '').trim();
    }
  }

  // Image attachments
  if (hasImages) {
    for (var ii = 0; ii < imageUrls.length; ii++) {
      html += '<div class="image-message">';
      html += '<img src="' + imageUrls[ii] + '" alt="Imagem" loading="lazy" onclick="openImageFullscreen(this.src)">';
      html += '</div>';
    }
  }

  // Audio attachment
  if (audioUrl) {
    html += '<div class="audio-message">';
    html += '<audio controls preload="metadata" src="' + audioUrl + '"></audio>';
    if (!audioTranscription && remainingText) {
      var isPlaceholder = /^O usuario enviou um audio/i.test(remainingText) || /^\[audio\]$/i.test(remainingText.trim());
      if (!isPlaceholder) {
        var cleanText = remainingText.replace(/^aqui\s+est[a\u00E1]\s+a\s+transcri[c\u00E7][a\u00E3]o.*?:\s*/i, '');
        cleanText = cleanText.replace(/^["\u201C\u201D](.+)["\u201C\u201D]$/, '$1');
        if (cleanText.trim()) {
          audioTranscription = cleanText.trim();
          remainingText = '';
        }
      }
    }
    if (audioTranscription) {
      html += '<blockquote class="audio-transcription">' + renderText(audioTranscription) + '</blockquote>';
    } else {
      html += '<blockquote class="audio-transcription processing"><span class="typing-dot"></span><span class="typing-dot"></span><span class="typing-dot"></span> Processando \u00e1udio...</blockquote>';
    }
    html += '</div>';
  }

  // File attachment cards
  if (hasFileInfos) {
    for (var fi = 0; fi < fileInfos.length; fi++) {
      var fi_info = fileInfos[fi];
      var fi_icon = getFileIcon(fi_info.mimeType);
      var fi_label = getFileTypeLabel(fi_info.mimeType);
      var fi_name = fi_info.name || 'arquivo';
      if (fi_info.url) {
        html += '<a class="file-attachment" href="' + fi_info.url + '" download="' + fi_name.replace(/"/g, '&quot;') + '" target="_blank">';
      } else {
        html += '<div class="file-attachment">';
      }
      html += '<span class="file-icon">' + fi_icon + '</span>';
      html += '<div class="file-details">';
      html += '<span class="file-name" title="' + fi_name.replace(/"/g, '&quot;') + '">' + escapeHtml(fi_name) + '</span>';
      html += '<span class="file-type">' + escapeHtml(fi_label) + '</span>';
      html += '</div>';
      html += fi_info.url ? '</a>' : '</div>';
    }
  }

  // If we had media, only show text if it's not a placeholder
  if (hasImages || audioUrl) {
    if (remainingText) {
      var isImgPlaceholder = /^O usuario enviou (uma imagem|\d+ imagens)/i.test(remainingText);
      var isAudioPlaceholder = /^O usuario enviou um audio/i.test(remainingText) || /^\[audio\]$/i.test(remainingText.trim());
      if (!isImgPlaceholder && !isAudioPlaceholder) {
        html += renderText(remainingText);
      }
    }
    return html || renderText(remainingText || displayText);
  }

  if (hasFileInfos) {
    if (displayText) html += renderText(displayText);
    return html || '';
  }

  return renderText(text);
}

// eslint-disable-next-line no-unused-vars
function openImageFullscreen(src) {
  // Support both DOM ID conventions: #image-overlay (viewers) and #image-fullscreen (web-ui)
  var overlay = document.getElementById('image-overlay') || document.getElementById('image-fullscreen');
  if (overlay) {
    var img = document.getElementById('fullscreen-img') || overlay.querySelector('img');
    if (img) img.src = src;
    overlay.classList.add('visible');
  }
}

// eslint-disable-next-line no-unused-vars
function closeImageFullscreen() {
  var overlay = document.getElementById('image-overlay') || document.getElementById('image-fullscreen');
  if (overlay) overlay.classList.remove('visible');
}

/**
 * Convert file paths in rendered HTML to download links.
 * Detects paths like /workspace/file.md, /tmp/output.pdf, /home/agent/result.json
 * in inline code (<code>) elements and adds a download button next to them.
 *
 * Requires global variables: window._dlSessionId, window._dlToken
 */
// eslint-disable-next-line no-unused-vars
function addFileDownloadLinks(containerEl) {
  if (!window._dlSessionId || !window._dlToken) return;

  var codes = containerEl.querySelectorAll('code');
  for (var i = 0; i < codes.length; i++) {
    var code = codes[i];
    // Skip code blocks inside <pre> (those are code blocks, not inline paths)
    if (code.parentElement && code.parentElement.tagName === 'PRE') continue;

    var text = code.textContent || '';
    // Match file paths in allowed directories
    if (/^\/?(?:workspace|tmp|home\/agent)\/\S+\.\w{1,10}$/.test(text.trim())) {
      var filePath = text.trim();
      if (!filePath.startsWith('/')) filePath = '/' + filePath;

      // Don't add link if already wrapped
      if (code.parentElement && code.parentElement.classList.contains('file-dl-wrap')) continue;

      var filename = filePath.split('/').pop() || filePath;
      var ext = (filename.split('.').pop() || '').toLowerCase();
      var icon = '📄';
      if (['pdf'].indexOf(ext) >= 0) icon = '📕';
      else if (['png','jpg','jpeg','gif','svg'].indexOf(ext) >= 0) icon = '🖼️';
      else if (['zip','tar','gz'].indexOf(ext) >= 0) icon = '📦';
      else if (['md','txt'].indexOf(ext) >= 0) icon = '📝';
      else if (['json','xml','yaml','yml'].indexOf(ext) >= 0) icon = '📋';

      var url = '/dl/' + window._dlSessionId + '/file?path=' + encodeURIComponent(filePath) + '&t=' + window._dlToken;

      var wrap = document.createElement('span');
      wrap.className = 'file-dl-wrap';

      var link = document.createElement('a');
      link.href = url;
      link.className = 'file-dl-link';
      link.target = '_blank';
      link.title = 'Baixar ' + filename;
      link.textContent = icon + ' ' + filename;

      code.parentElement.insertBefore(wrap, code);
      wrap.appendChild(code);
      wrap.appendChild(document.createTextNode(' '));
      wrap.appendChild(link);
    }
  }
}
