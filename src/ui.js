import chalk from 'chalk';

const accents = new Map([
  ['cyber', '#80BDCF'],
  ['aurora', '#8DC5BD'],
  ['synth', '#D5A6AF'],
  ['matrix', '#AFBF9C'],
]);

export const accent = chalk.hex(accents.get(process.env.MULTICODEXSTATE_THEME?.toLowerCase()) || accents.get('cyber'));
export const warning = chalk.hex('#D8B678');
export const failure = chalk.hex('#E29A96');

/** Strip SGR ANSI escape sequences from text. */
export function stripAnsi(text) {
  return String(text ?? '').replace(/\u001b\[[0-9;]*m/g, '');
}

/** Terminal cell width of a single Unicode code point. */
export function charWidth(ch) {
  const cp = ch.codePointAt(0);
  if (cp == null) return 0;
  if (cp === 0x200d || (cp >= 0xfe00 && cp <= 0xfe0f) || (cp >= 0x0300 && cp <= 0x036f)) {
    return 0;
  }
  const wide =
    (cp >= 0x1100 && cp <= 0x115f) || // Hangul Jamo
    (cp >= 0x2e80 && cp <= 0xa4cf) || // CJK radicals … Yi
    (cp >= 0xac00 && cp <= 0xd7a3) || // Hangul syllables
    (cp >= 0xf900 && cp <= 0xfaff) || // CJK compatibility ideographs
    (cp >= 0xfe30 && cp <= 0xfe6f) || // CJK compatibility forms
    (cp >= 0xff00 && cp <= 0xff60) || // fullwidth forms
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x20000 && cp <= 0x3fffd); // CJK ext. B+
  return wide ? 2 : 1;
}

/**
 * Terminal display width of a string.
 * Counts ANSI escapes as zero and CJK/wide glyphs as two cells.
 */
export function displayWidth(text) {
  const stripped = stripAnsi(text);
  let width = 0;
  for (const ch of stripped) {
    width += charWidth(ch);
  }
  return width;
}

/** Pad a (possibly colourised) string to a target terminal display width. */
export function padVisible(text, width, align = 'left') {
  const gap = Math.max(0, width - displayWidth(text));
  if (gap === 0) return text;
  if (align === 'right') return ' '.repeat(gap) + text;
  if (align === 'center') {
    const left = Math.floor(gap / 2);
    return ' '.repeat(left) + text + ' '.repeat(gap - left);
  }
  return text + ' '.repeat(gap);
}

/**
 * Truncate to a display width while preserving SGR sequences up to the cut
 * point and resetting style if ANSI codes were emitted before truncation.
 */
export function truncateVisible(text, width, ellipsis = '…') {
  const str = String(text ?? '');
  if (width <= 0) return '';
  if (displayWidth(str) <= width) return str;

  const ellWidth = width >= 2 ? displayWidth(ellipsis) : 0;
  const limit = Math.max(0, width - ellWidth);
  const ansiRe = /^\u001b\[[0-9;]*m/;

  let out = '';
  let used = 0;
  let sawAnsi = false;
  let i = 0;

  while (i < str.length) {
    const rest = str.slice(i);
    const match = ansiRe.exec(rest);
    if (match) {
      out += match[0];
      sawAnsi = true;
      i += match[0].length;
      continue;
    }

    const cp = str.codePointAt(i);
    const ch = String.fromCodePoint(cp);
    const w = charWidth(ch);
    if (used + w > limit) break;
    out += ch;
    used += w;
    i += ch.length;
  }

  if (ellWidth > 0 && used + ellWidth <= width) {
    out += ellipsis;
  }
  if (sawAnsi) out += '\u001b[0m';
  return out;
}

export function tag(label) {
  return chalk.gray(`[${label}]`);
}

export function planBadge(plan) {
  return plan ? tag(String(plan).toUpperCase()) : '';
}

export function activeBadge() {
  return accent('[ACTIVE]');
}

export function statusChip(state) {
  if (state === 'expired' || state === 'invalid') return failure(state);
  if (state === 'expiring') return warning(state);
  return state || 'unknown';
}

function usageColor(percent) {
  if (percent >= 90) return failure;
  if (percent >= 70) return warning;
  return accent;
}

export function paintPercent(percent) {
  return percent == null ? chalk.gray('—') : usageColor(percent)(`${percent.toFixed(1)}%`);
}

export function paintBar(percent, width = 22) {
  const filled = Math.round(width * Math.max(0, Math.min(100, percent ?? 0)) / 100);
  return usageColor(percent)('━'.repeat(filled)) + chalk.gray('─'.repeat(width - filled));
}

/** Effective card width: stable 78 cols when piped, responsive on wide TTYs. */
export function frameWidth() {
  if (!process.stdout.isTTY || !process.stdout.columns) return 78;
  return Math.min(84, Math.max(72, process.stdout.columns - 2));
}

function buildTopBorder({ title = '', titleRight = '', width = 78, border = chalk.gray }) {
  if (!title && !titleRight) {
    return border(`╭${'─'.repeat(Math.max(0, width - 2))}╮`);
  }

  let leftTitle = title;
  let rightTitle = titleRight;

  const overhead = (leftTitle ? 4 : 1) + (rightTitle ? 4 : 1);
  const maxContent = Math.max(4, width - overhead - 1);
  if (displayWidth(leftTitle) + displayWidth(rightTitle) > maxContent) {
    if (rightTitle && displayWidth(rightTitle) > Math.floor(maxContent * 0.45)) {
      rightTitle = truncateVisible(rightTitle, Math.floor(maxContent * 0.45));
    }
    const remaining = Math.max(2, maxContent - displayWidth(rightTitle));
    if (displayWidth(leftTitle) > remaining) {
      leftTitle = truncateVisible(leftTitle, remaining);
    }
  }

  const leftText = leftTitle ? `${border('╭─')} ${leftTitle} ` : border('╭');
  const rightText = rightTitle ? ` ${rightTitle} ${border('─╮')}` : border('╮');
  const dashes = Math.max(1, width - displayWidth(leftText) - displayWidth(rightText));
  return leftText + border('─'.repeat(dashes)) + rightText;
}

/**
 * Render a Unicode card with subtle borders, optional embedded
 * header titles, and `---` inner horizontal dividers.
 */
export function renderCard({
  title = '',
  titleRight = '',
  lines = [],
  width = frameWidth(),
  border = chalk.gray,
  indent = '  ',
} = {}) {
  const out = [];
  const bodyWidth = Math.max(10, width - 6);

  out.push(indent + buildTopBorder({ title, titleRight, width, border }));

  for (const line of lines) {
    if (line === '---') {
      out.push(indent + border(`├${'─'.repeat(width - 2)}┤`));
      continue;
    }
    const wall = border('│');
    const fitted = padVisible(truncateVisible(line, bodyWidth), bodyWidth);
    out.push(`${indent}${wall}  ${fitted}  ${wall}`);
  }

  out.push(indent + border(`╰${'─'.repeat(width - 2)}╯`));
  return out.join('\n');
}

/** Render a sleek outer-framed table with header rule and CJK-safe column alignment. */
export function renderTable({
  columns,
  rows,
  width = frameWidth(),
  border = chalk.gray,
  indent = '  ',
} = {}) {
  const gap = 2;
  const innerWidth = width - 6;
  const fixedTotal = columns.reduce((sum, c) => sum + (c.width || 0), 0) + gap * (columns.length - 1);
  const flexCols = columns.filter((c) => !c.width);
  const flexWidth = flexCols.length
    ? Math.max(8, Math.floor((innerWidth - fixedTotal) / flexCols.length))
    : 0;

  const colWidths = columns.map((c) => c.width || flexWidth);
  const formatRow = (cells) =>
    cells
      .map((cell, i) => padVisible(truncateVisible(cell, colWidths[i]), colWidths[i], columns[i].align || 'left'))
      .join(' '.repeat(gap));

  const headerLine = formatRow(columns.map((c) => chalk.gray.bold(c.label)));
  const bodyLines = rows.map((row) => formatRow(row));

  return renderCard({
    lines: [headerLine, '---', ...bodyLines],
    width,
    border,
    indent,
  });
}

export function renderCommandHeader({ title, badges = [], subtitle = '', width = frameWidth() }) {
  return renderCard({
    title: accent.bold(title),
    titleRight: badges.filter(Boolean).join(' '),
    lines: subtitle ? [subtitle] : [],
    width,
  });
}

export function sectionRule(label, width = frameWidth()) {
  return '  ' + accent.bold(label) + chalk.gray(' ' + '─'.repeat(Math.max(0, width - displayWidth(label) - 1)));
}

// Only interactive callers need temporary progress feedback.
export async function withProgress(label, fn) {
  if (!process.stdout.isTTY) return fn();
  process.stdout.write(`  ${chalk.gray(truncateVisible(label, frameWidth()))}`);
  try {
    return await fn();
  } finally {
    process.stdout.clearLine(0);
    process.stdout.cursorTo(0);
  }
}

function editDistance(a, b) {
  const dp = Array.from({ length: a.length + 1 }, (_, i) => [i]);
  for (let j = 1; j <= b.length; j += 1) dp[0][j] = j;
  for (let i = 1; i <= a.length; i += 1) {
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + cost);
    }
  }
  return dp[a.length][b.length];
}

/** Suggest the closest known CLI command for a typo, or null. */
export function suggestCommand(input, candidates) {
  const raw = String(input || '').toLowerCase();
  if (!raw) return null;
  let best = null;
  let bestDist = Infinity;
  for (const cand of candidates) {
    const d = editDistance(raw, cand);
    if (d < bestDist) {
      bestDist = d;
      best = cand;
    }
  }
  return best && bestDist <= 2 ? best : null;
}
