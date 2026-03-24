/**
 * Shared tool-use block logic — OpenCode-inspired design.
 * Used by both web-ui.html and session-viewer.html.
 *
 * Exports (global functions):
 *   - formatToolLine(text, timeStr) → HTML string for a single tool line
 *   - makeToolUseBlock()            → DOM element (collapsible tool block)
 */

/* eslint-disable no-unused-vars */

/**
 * Map tool names to icons (OpenCode-inspired single-char icons).
 */
var TOOL_ICONS = {
  'bash': '$',
  'read': '\u2192',      // →
  'write': '\u25CB',     // ○
  'edit': '\u25CB',      // ○
  'glob': '\u2731',      // ✱
  'grep': '\u2731',      // ✱
  'task': '\u2502',      // │
  'webfetch': '%',
  'playwright': '\u25C7', // ◇
  'todowrite': '\u2611',  // ☑
  'question': '?'
};

/**
 * Detect if a tool call line represents a completed action (has status suffix).
 */
function isToolCompleted(text) {
  return /\b(ok|completed|done)\b/i.test(text) || /\d+ms\b/.test(text);
}

/**
 * Extract tool name from text for icon lookup.
 * Looks for backtick-delimited first segment or common prefixes.
 */
function extractToolName(text) {
  // Match [tool_name:status] pattern
  var bracketMatch = text.match(/\[([a-z_]+)/i);
  if (bracketMatch) {
    var name = bracketMatch[1].replace(/^rick_/, '');
    return name.toLowerCase();
  }
  // Match first backtick segment
  var btMatch = text.match(/`([^`]+)`/);
  if (btMatch) return btMatch[1].toLowerCase();
  return '';
}

/**
 * Get icon for a tool name.
 */
function getToolIcon(toolName) {
  if (!toolName) return '\u25B8'; // ▸
  var lower = toolName.toLowerCase();
  for (var key in TOOL_ICONS) {
    if (lower.indexOf(key) !== -1) return TOOL_ICONS[key];
  }
  return '\u25B8'; // ▸ default
}

/**
 * Format a tool execution line with syntax-highlighted segments.
 * Backtick-delimited segments: first = tool name (blue), rest = args (cyan).
 * Plain text segments shown in muted color.
 *
 * Enhanced: detects completed vs in-progress, applies muting, adds icons.
 */
function formatToolLine(text, timeStr) {
  var completed = isToolCompleted(text);
  var toolName = extractToolName(text);
  var icon = getToolIcon(toolName);

  var timeEl = '<span class="tl-time">' + timeStr + '</span>';
  var iconEl = '<span class="tl-arrow">' + icon + '</span>';

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
      var cls = completed ? 'tl-tool-done' : 'tl-tool';
      return '<span class="' + cls + '">' + escaped + '</span>';
    }
    if (s.type === 'arg')  return '<span class="tl-arg">' + escaped + '</span>';
    return '<span class="tl-plain">' + escaped + '</span>';
  }).join(' ');

  return timeEl + iconEl + contentHtml;
}

/**
 * Create a new collapsible tool block element.
 * Minimizes all existing blocks and returns the new (expanded) block.
 */
function makeToolUseBlock() {
  // Minimize all existing tool blocks
  var existing = document.querySelectorAll('.tool-use-block');
  for (var i = 0; i < existing.length; i++) {
    existing[i].classList.add('minimized');
  }

  var block = document.createElement('div');
  block.className = 'tool-use-block';
  block.innerHTML =
    '<div class="terminal-header">' +
      '<div class="terminal-title">ferramentas</div>' +
      '<div class="terminal-toggle">\u25BE</div>' +
    '</div>' +
    '<div class="terminal-body"></div>';

  var header = block.querySelector('.terminal-header');
  header.addEventListener('click', function() {
    if (block.classList.contains('minimized')) {
      // Expand this one, minimize all others
      var all = document.querySelectorAll('.tool-use-block');
      for (var j = 0; j < all.length; j++) all[j].classList.add('minimized');
      block.classList.remove('minimized');
    } else {
      block.classList.add('minimized');
    }
  });

  return block;
}
