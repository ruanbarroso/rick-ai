/**
 * Shared tool-use rendering — OpenCode-inspired inline tool calls.
 * Used by both web-ui.html and session-viewer.html.
 *
 * Each tool call renders as a SINGLE line that morphs:
 *   Running:   ⠋ [bash] $ echo hello        (blue, spinner)
 *   Completed: $ [bash] $ echo hello  53ms   (muted, icon)
 *   Error:     $ [bash] $ echo hello  erro   (red)
 *
 * The "completed" event UPDATES the existing start line instead of
 * creating a new line, matching OpenCode's behavior.
 *
 * Exports (global):
 *   - isStatusLine(text)
 *   - isToolCompleted(text), isToolError(text), isToolStart(text)
 *   - extractToolName(text)
 *   - formatToolLine(text, timeStr) → HTML
 *   - formatToolCompletedSuffix(text) → { name, duration, preview }
 *   - makeToolUseBlock() → DOM element
 *   - _minimizeBlock(block), _trackToolCall(block, text)
 */

/* eslint-disable no-unused-vars */

function isStatusLine(text) {
  if (!text) return false;
  var t = text.trim();
  return t === 'Pensando ...' || t === 'Pensando...' || /^Pensando\s*\.{2,}$/.test(t);
}

function isToolCompleted(text) {
  return /\[[\w_]+:ok\]/.test(text) || /\[[\w_]+:erro\]/.test(text);
}

function isToolError(text) {
  return /\[[\w_]+:erro\]/.test(text);
}

function isToolStart(text) {
  return /\[[\w_]+\]/.test(text) && !isToolCompleted(text);
}

function extractToolName(text) {
  var m = text.match(/\[([a-z_]+?)(?::(?:ok|erro))?\]/i);
  return m ? m[1].replace(/^rick_/, '') : '';
}

var TOOL_ICONS = {
  'bash': '$', 'run_command': '$',
  'read': '\u2192', 'write': '\u2190', 'edit': '\u2190',
  'glob': '\u2731', 'grep': '\u2731',
  'task': '\u2502', 'webfetch': '%', 'playwright': '\u25C7',
  'todowrite': '\u2611', 'question': '?',
  'rick_search': '\u2731', 'rick_memory': '\u2605',
  'rick_save_memory': '\u2605', 'rick_delete_memory': '\u2605'
};

function getToolIcon(name) {
  if (!name) return '\u2699';
  var lower = name.toLowerCase();
  if (TOOL_ICONS[lower]) return TOOL_ICONS[lower];
  for (var key in TOOL_ICONS) {
    if (lower.indexOf(key) !== -1) return TOOL_ICONS[key];
  }
  return '\u2699';
}

/**
 * Parse a completed line to extract duration and preview.
 * Input: `[bash:ok]` `53ms · Hello world`
 * Returns: { name: "bash", duration: "53ms", preview: "Hello world" }
 */
function formatToolCompletedSuffix(text) {
  var name = extractToolName(text);
  var duration = '';
  var preview = '';
  // Extract the arg segment (second backtick pair)
  var m = text.match(/`\[[^\]]+\]`\s*`([^`]*)`/);
  if (m) {
    var parts = m[1].split('\u00B7'); // split on ·
    if (!parts[0]) parts = m[1].split('·'); // try regular dot
    duration = (parts[0] || '').trim();
    preview = (parts.slice(1).join('·') || '').trim();
  }
  return { name: name, duration: duration, preview: preview };
}

/**
 * Escape HTML entities.
 */
function _esc(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * Format a tool START line into HTML.
 * Shows as running state with spinner icon.
 */
function formatToolLine(text, timeStr) {
  var completed = isToolCompleted(text);
  var error = isToolError(text);
  var toolName = extractToolName(text);
  var icon = getToolIcon(toolName);

  // For completed lines, format as merged line (icon + name + args + duration)
  if (completed) {
    var info = formatToolCompletedSuffix(text);
    var iconCls = error ? 'tl-icon err' : 'tl-icon ok';
    var toolCls = error ? 'tl-tool err' : 'tl-tool done';
    var durHtml = info.duration ? '<span class="tl-dur">' + _esc(info.duration) + '</span>' : '';
    var prevHtml = info.preview ? '<span class="tl-preview">' + _esc(info.preview.length > 120 ? info.preview.slice(0, 117) + '...' : info.preview) + '</span>' : '';
    return '<span class="tl-icon ' + (error ? 'err' : 'ok') + '">' + icon + '</span>' +
           '<span class="' + toolCls + '">[' + _esc(info.name) + ']</span> ' +
           durHtml + (prevHtml ? ' ' + prevHtml : '');
  }

  // Start line — show with spinner
  var segments = [];
  var regex = /`([^`]*)`/g;
  var match;
  var lastIdx = 0;
  var first = true;

  while ((match = regex.exec(text)) !== null) {
    if (match.index > lastIdx) {
      var plain = text.slice(lastIdx, match.index).trim();
      if (plain) segments.push({ type: 'plain', val: plain });
    }
    if (first) {
      segments.push({ type: 'tool', val: match[1] });
      first = false;
    } else {
      segments.push({ type: 'arg', val: match[1] });
    }
    lastIdx = regex.lastIndex;
  }

  if (lastIdx < text.length) {
    var remainder = text.slice(lastIdx).trim();
    if (remainder) segments.push({ type: first ? 'tool' : 'plain', val: remainder });
  }

  if (segments.length === 0) {
    segments.push({ type: 'plain', val: text });
  }

  var contentHtml = segments.map(function(s) {
    var escaped = _esc(s.val);
    if (s.type === 'tool') return '<span class="tl-tool active">' + escaped + '</span>';
    if (s.type === 'arg') return '<span class="tl-arg">' + escaped + '</span>';
    return '<span class="tl-plain">' + escaped + '</span>';
  }).join(' ');

  return '<span class="tl-icon active spinner">' + icon + '</span>' + contentHtml;
}

function makeToolUseBlock() {
  var existing = document.querySelectorAll('.tool-use-block');
  for (var i = 0; i < existing.length; i++) {
    if (!existing[i].classList.contains('minimized')) {
      _minimizeBlock(existing[i]);
    }
  }

  var block = document.createElement('div');
  block.className = 'tool-use-block';
  block.setAttribute('data-tool-count', '0');
  block.setAttribute('data-error-count', '0');
  block.innerHTML =
    '<div class="terminal-header">' +
      '<div class="terminal-title">ferramentas</div>' +
      '<div class="terminal-summary"></div>' +
      '<div class="terminal-toggle">\u25BE</div>' +
    '</div>' +
    '<div class="terminal-body"></div>';

  var header = block.querySelector('.terminal-header');
  header.addEventListener('click', function() {
    if (block.classList.contains('minimized')) {
      var all = document.querySelectorAll('.tool-use-block');
      for (var j = 0; j < all.length; j++) {
        if (all[j] !== block && !all[j].classList.contains('minimized')) {
          _minimizeBlock(all[j]);
        }
      }
      block.classList.remove('minimized');
    } else {
      _minimizeBlock(block);
    }
  });

  return block;
}

function _minimizeBlock(block) {
  block.classList.add('minimized');
  var count = parseInt(block.getAttribute('data-tool-count') || '0', 10);
  var errCount = parseInt(block.getAttribute('data-error-count') || '0', 10);
  var summary = block.querySelector('.terminal-summary');
  if (summary) {
    var text = count + (count === 1 ? ' chamada' : ' chamadas');
    if (errCount > 0) {
      text += ' \u00B7 ' + errCount + (errCount === 1 ? ' erro' : ' erros');
    }
    summary.textContent = text;
  }
}

function _trackToolCall(block, text) {
  if (isStatusLine(text)) return;
  if (isToolStart(text)) {
    var c = parseInt(block.getAttribute('data-tool-count') || '0', 10);
    block.setAttribute('data-tool-count', String(c + 1));
  }
  if (isToolError(text)) {
    var e = parseInt(block.getAttribute('data-error-count') || '0', 10);
    block.setAttribute('data-error-count', String(e + 1));
  }
}
