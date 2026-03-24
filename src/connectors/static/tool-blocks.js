/**
 * Shared tool-use rendering — OpenCode-inspired inline tool calls.
 * Used by both web-ui.html and session-viewer.html.
 *
 * Tool calls render as individual inline elements in the message flow,
 * NOT as a grouped terminal block. Each tool call is a compact line
 * with status icon, name, args, and optional output preview.
 *
 * Exports (global functions):
 *   - formatToolLine(text, timeStr) → HTML string for a single tool line
 *   - makeToolUseBlock()            → DOM element (collapsible group)
 *   - isStatusLine(text)            → boolean — detect "Pensando..." lines
 */

/* eslint-disable no-unused-vars */

/**
 * Detect if a tool line is a "Pensando..." / status indicator.
 */
function isStatusLine(text) {
  if (!text) return false;
  var t = text.trim();
  return t === 'Pensando ...' || t === 'Pensando...' || /^Pensando\s*\.{2,}$/.test(t);
}

/**
 * Detect if line is a tool completion (has :ok or duration).
 */
function isToolCompleted(text) {
  return /\[[\w_]+:ok\]/.test(text) || /\[[\w_]+:erro\]/.test(text);
}

/**
 * Detect if line is a tool error.
 */
function isToolError(text) {
  return /\[[\w_]+:erro\]/.test(text);
}

/**
 * Detect if line is a tool start.
 */
function isToolStart(text) {
  return /\[[\w_]+\]/.test(text) && !isToolCompleted(text);
}

/**
 * Extract tool name from text.
 */
function extractToolName(text) {
  var m = text.match(/\[([a-z_]+?)(?::(?:ok|erro))?\]/i);
  return m ? m[1].replace(/^rick_/, '') : '';
}

/**
 * Map tool names to compact icons.
 */
var TOOL_ICONS = {
  'bash': '$',
  'run_command': '$',
  'read': '\u2192',
  'write': '\u25CB',
  'edit': '\u270E',
  'glob': '\u2731',
  'grep': '\u2731',
  'task': '\u25A1',
  'webfetch': '%',
  'playwright': '\u25C7',
  'todowrite': '\u2611',
  'question': '?',
  'rick_search': '\u26B2',
  'rick_memory': '\u2605',
  'rick_save_memory': '\u2605'
};

function getToolIcon(name) {
  if (!name) return '\u25B8';
  var lower = name.toLowerCase();
  if (TOOL_ICONS[lower]) return TOOL_ICONS[lower];
  for (var key in TOOL_ICONS) {
    if (lower.indexOf(key) !== -1) return TOOL_ICONS[key];
  }
  return '\u25B8';
}

/**
 * Format a tool line into HTML.
 *
 * Input format examples:
 *   Start:     `[bash]` `$ echo hello`
 *   Completed: `[bash:ok]` `53ms · output preview text`
 *   Error:     `[bash:erro]` `error message`
 *   Status:    Pensando ...
 */
function formatToolLine(text, timeStr) {
  var completed = isToolCompleted(text);
  var error = isToolError(text);
  var status = isStatusLine(text);
  var toolName = extractToolName(text);
  var icon = status ? '\u2026' : getToolIcon(toolName);

  // Status line (Pensando...) — rendered differently
  if (status) {
    return '<span class="tl-time">' + timeStr + '</span>' +
           '<span class="tl-status-icon spinner">\u2026</span>' +
           '<span class="tl-status-text">Pensando \u2026</span>';
  }

  var timeEl = '<span class="tl-time">' + timeStr + '</span>';

  // Icon with status coloring
  var iconCls = 'tl-icon';
  if (error) iconCls += ' err';
  else if (completed) iconCls += ' ok';
  else iconCls += ' active';
  var iconEl = '<span class="' + iconCls + '">' + icon + '</span>';

  // Parse backtick segments
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
    var escaped = s.val.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    if (s.type === 'tool') {
      if (error) return '<span class="tl-tool err">' + escaped + '</span>';
      if (completed) return '<span class="tl-tool done">' + escaped + '</span>';
      return '<span class="tl-tool active">' + escaped + '</span>';
    }
    if (s.type === 'arg') {
      if (completed) return '<span class="tl-arg done">' + escaped + '</span>';
      return '<span class="tl-arg">' + escaped + '</span>';
    }
    return '<span class="tl-plain">' + escaped + '</span>';
  }).join(' ');

  return timeEl + iconEl + contentHtml;
}

/**
 * Create a new collapsible tool block.
 * When minimized, shows a summary of tool calls count.
 * When expanded, shows individual tool lines.
 */
function makeToolUseBlock() {
  // Minimize all existing tool blocks
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

/**
 * Minimize a block and update its summary text.
 */
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

/**
 * Track tool calls in a block.
 */
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
