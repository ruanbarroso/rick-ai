/**
 * Shared tool-use rendering — OpenCode-inspired.
 *
 * New format from backend:
 *   Start:     `Read` `src/file.ts`
 *   Completed: `Read:ok` `src/file.ts` `23ms`
 *   Error:     `Read:erro` `error message`
 *
 * Legacy format (still supported):
 *   Start:     `[read]` `path`
 *   Completed: `[read:ok]` `23ms · output`
 */

/* eslint-disable no-unused-vars */

function isStatusLine(text) {
  if (!text) return false;
  var t = text.trim();
  return t === 'Pensando ...' || t === 'Pensando...' || /^Pensando\s*\.{2,}$/.test(t);
}

function isToolCompleted(text) {
  return /`:ok`|:ok\]|`:erro`|:erro\]/i.test(text);
}

function isToolError(text) {
  return /`:erro`|:erro\]/i.test(text);
}

function isToolStart(text) {
  if (isToolCompleted(text)) return false;
  // New format: `ToolName` `arg`  OR  Legacy: `[tool]` `arg`
  return /^[\s\n]*`[A-Z][\w]*`\s/m.test(text) || /^[\s\n]*`\[[\w_]+\]`\s/m.test(text);
}

function extractToolName(text) {
  // New format: `Read:ok` or `Read`
  var mNew = text.match(/`([A-Z][\w]*)(?::(?:ok|erro))?`/);
  if (mNew) return mNew[1];
  // Legacy: [read:ok] or [read]
  var mLeg = text.match(/\[([a-z_]+?)(?::(?:ok|erro))?\]/i);
  if (mLeg) return mLeg[1].replace(/^rick_/, '');
  return '';
}

var TOOL_ICONS = {
  'Read': '\u2192', 'Write': '\u2190', 'Edit': '\u2190',
  'Bash': '$', 'Glob': '\u2731', 'Grep': '\u2731',
  'Task': '\u2502', 'WebFetch': '%',
  'Navigate': '\u25C7', 'Click': '\u25C7', 'Snapshot': '\u25C7',
  'Type': '\u25C7', 'Screenshot': '\u25C7', 'Evaluate': '\u25C7', 'RunCode': '\u25C7',
  'TodoWrite': '\u2611', 'Question': '?', 'Skill': '\u2192',
  'Search': '\u2731', 'Memory': '\u2605', 'SaveMemory': '\u2605', 'DeleteMemory': '\u2605',
  // Legacy lowercase
  'read': '\u2192', 'write': '\u2190', 'edit': '\u2190',
  'bash': '$', 'run_command': '$', 'glob': '\u2731', 'grep': '\u2731',
  'task': '\u2502', 'webfetch': '%', 'todowrite': '\u2611',
  'question': '?', 'rick_search': '\u2731', 'rick_memory': '\u2605',
  'rick_save_memory': '\u2605', 'rick_delete_memory': '\u2605',
  'playwright': '\u25C7'
};

function getToolIcon(name) {
  if (!name) return '\u2699';
  if (TOOL_ICONS[name]) return TOOL_ICONS[name];
  var lower = name.toLowerCase();
  for (var key in TOOL_ICONS) {
    if (lower === key.toLowerCase()) return TOOL_ICONS[key];
  }
  return '\u2699';
}

function _esc(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * Parse backtick segments from tool line text.
 * Returns array of strings (content between backticks).
 */
function _parseSegments(text) {
  var segments = [];
  var regex = /`([^`]*)`/g;
  var match;
  while ((match = regex.exec(text)) !== null) {
    segments.push(match[1]);
  }
  return segments;
}

/**
 * Format a tool line (start or completed) into HTML.
 */
function formatToolLine(text, timeStr) {
  var completed = isToolCompleted(text);
  var error = isToolError(text);
  var segs = _parseSegments(text);
  var toolName = '';
  var args = [];
  var duration = '';

  if (segs.length > 0) {
    // First segment is tool name (possibly with :ok/:erro suffix)
    toolName = segs[0].replace(/:ok$|:erro$/i, '');
    // For legacy format, strip brackets
    toolName = toolName.replace(/^\[|\]$/g, '');
    // Capitalize if lowercase legacy name
    if (toolName && toolName[0] === toolName[0].toLowerCase()) {
      toolName = toolName.charAt(0).toUpperCase() + toolName.slice(1);
    }
    // Remove rick_ prefix
    toolName = toolName.replace(/^Rick_/i, '');

    // Remaining segments are args + possibly duration
    for (var i = 1; i < segs.length; i++) {
      var seg = segs[i];
      // Duration detection: ends with 'ms' and is numeric prefix
      if (/^\d+ms$/.test(seg)) {
        duration = seg;
      } else if (/^\d+ms\s*·/.test(seg)) {
        // Legacy format: "23ms · output preview"
        duration = seg.split('·')[0].trim();
      } else {
        args.push(seg);
      }
    }
  }

  if (!toolName) {
    toolName = extractToolName(text);
  }

  var icon = getToolIcon(toolName);

  // Build HTML
  var iconCls = 'tl-icon';
  if (error) iconCls += ' err';
  else if (completed) iconCls += ' ok';
  else iconCls += ' active spinner';

  var toolCls = 'tl-tool';
  if (error) toolCls += ' err';
  else if (completed) toolCls += ' done';
  else toolCls += ' active';

  var html = '<span class="' + iconCls + '">' + _esc(icon) + '</span>';
  html += '<span class="' + toolCls + '">' + _esc(toolName) + '</span>';

  for (var j = 0; j < args.length; j++) {
    var argCls = completed ? 'tl-arg done' : 'tl-arg';
    var argText = args[j];
    // Truncate long args
    if (argText.length > 140) argText = argText.slice(0, 137) + '...';
    html += ' <span class="' + argCls + '">' + _esc(argText) + '</span>';
  }

  if (duration) {
    html += ' <span class="tl-dur">' + _esc(duration) + '</span>';
  }

  return html;
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
