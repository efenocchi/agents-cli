/**
 * Interactive fuzzy-filter picker built on @inquirer/core.
 *
 * Provides a searchable, paginated list UI with optional preview pane
 * for selecting items in the terminal. Used by session picker, command
 * picker, and other interactive selection flows.
 */

/**
 * Custom inquirer prompt for searchable, scrollable selection lists.
 *
 * Extends @inquirer/core to support type-ahead filtering, column-aligned
 * display, and keyboard navigation. Used by sessions, teams, and other
 * interactive pickers throughout the CLI.
 */

import {
  createPrompt,
  useState,
  useKeypress,
  useEffect,
  useMemo,
  usePagination,
  usePrefix,
  makeTheme,
  isEnterKey,
  isUpKey,
  isDownKey,
  isSpaceKey,
  Separator,
} from '@inquirer/core';
import chalk from 'chalk';
import { stripVTControlCharacters } from 'node:util';

/** Configuration for the interactive picker prompt. */
export interface PickerConfig<T> {
  message: string;
  items: T[];
  filter: (query: string) => T[];
  labelFor: (item: T, query: string) => string;
  buildPreview?: (item: T) => string;
  shortIdFor?: (item: T) => string;
  pageSize?: number;
  initialSearch?: string;
  emptyMessage?: string;
  enterHint?: string;
}

/** The result returned when the user selects an item. */
export interface PickedItem<T> {
  item: T;
}

interface Choice<T> {
  value: T;
  label: string;
}

const DEFAULT_TERMINAL_ROWS = 24;
const DEFAULT_TERMINAL_WIDTH = 80;

function terminalWidth(): number {
  return Math.max(1, process.stdout.columns || DEFAULT_TERMINAL_WIDTH);
}

function terminalRows(): number {
  return Math.max(1, process.stdout.rows || DEFAULT_TERMINAL_ROWS);
}

function renderedRows(text: string, width: number): number {
  const normalizedWidth = Math.max(1, width);
  return text.split('\n').reduce((rows, line) => {
    const visible = stripVTControlCharacters(line).length;
    return rows + Math.max(1, Math.ceil(visible / normalizedWidth));
  }, 0);
}

function truncateAnsiLine(line: string, maxVisibleWidth: number): string {
  if (maxVisibleWidth <= 0) return '';

  const targetWidth = Math.max(0, maxVisibleWidth - 1);
  const ansiPattern = /\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1b\\))/y;
  let out = '';
  let visible = 0;

  for (let i = 0; i < line.length;) {
    ansiPattern.lastIndex = i;
    const ansi = ansiPattern.exec(line);
    if (ansi) {
      out += ansi[0];
      i = ansiPattern.lastIndex;
      continue;
    }

    const char = line[i];
    if (visible >= targetWidth) break;
    out += char;
    visible += 1;
    i += char.length;
  }

  return out + '\x1b[0m' + chalk.gray('…');
}

function takePreviewRows(preview: string, rowBudget: number, width: number): string[] {
  const lines = preview.split('\n');
  const out: string[] = [];
  let used = 0;

  for (const line of lines) {
    const lineRows = renderedRows(line, width);
    if (used + lineRows <= rowBudget) {
      out.push(line);
      used += lineRows;
      continue;
    }

    const remainingRows = rowBudget - used;
    if (remainingRows > 0) {
      out.push(truncateAnsiLine(line, remainingRows * width));
    }
    break;
  }

  return out;
}

function previewTruncatedMarker(width: number): string {
  const full = '... preview truncated to fit terminal';
  const short = '... truncated';
  const text = full.length <= width ? full : short;
  if (text.length <= width) return chalk.gray(text);
  return chalk.gray(text.slice(0, Math.max(0, width - 1)) + '…');
}

/** Clip a picker preview so the full prompt can fit in the terminal viewport. */
export function limitPreviewHeight(preview: string, maxRows: number, width: number): string {
  const normalizedRows = Math.max(0, maxRows);
  if (normalizedRows === 0) return '';
  if (renderedRows(preview, width) <= normalizedRows) return preview;
  if (normalizedRows === 1) return previewTruncatedMarker(width);

  const lines = takePreviewRows(preview, normalizedRows - 1, width);
  lines.push(previewTruncatedMarker(width));
  return lines.join('\n');
}

/** Show an interactive fuzzy-filter picker and return the selected item, or null on cancel. */
export function itemPicker<T>(config: PickerConfig<T>): Promise<PickedItem<T> | null> {
  const prompt = createPrompt<PickedItem<T> | null, PickerConfig<T>>((cfg, done) => {
    const theme = makeTheme({});
    const [status, setStatus] = useState<'idle' | 'done'>('idle');
    const [searchTerm, setSearchTerm] = useState(cfg.initialSearch ?? '');
    const [previewOpen, setPreviewOpen] = useState(Boolean(cfg.buildPreview));
    const prefix = usePrefix({ status, theme });

    const results = useMemo(() => {
      const filtered = cfg.filter(searchTerm).slice(0, 50);
      return filtered.map<Choice<T>>((item) => ({
        value: item,
        label: cfg.labelFor(item, searchTerm),
      }));
    }, [searchTerm]);

    const [active, setActive] = useState(0);

    useEffect(() => {
      if (active >= results.length) setActive(0);
    }, [results]);

    const selected = results[active];

    useKeypress((key, rl) => {
      if (isEnterKey(key)) {
        if (selected) {
          setStatus('done');
          done({ item: selected.value });
        }
        return;
      }

      if (isSpaceKey(key) && searchTerm === '' && cfg.buildPreview) {
        rl.clearLine(0);
        setPreviewOpen(!previewOpen);
        return;
      }

      if (isUpKey(key)) {
        rl.clearLine(0);
        if (results.length > 0) {
          setActive((active - 1 + results.length) % results.length);
        }
        return;
      }

      if (isDownKey(key)) {
        rl.clearLine(0);
        if (results.length > 0) {
          setActive((active + 1) % results.length);
        }
        return;
      }

      setSearchTerm(rl.line);
      if (previewOpen) setPreviewOpen(false);
    });

    const message = theme.style.message(cfg.message, status);

    if (status === 'done' && selected) {
      const shortId = cfg.shortIdFor ? cfg.shortIdFor(selected.value) : '';
      return `${prefix} ${message}${shortId ? ' ' + chalk.cyan(shortId) : ''}`;
    }

    const hasPreview = Boolean(cfg.buildPreview);
    const placeholder = hasPreview
      ? '(type to filter, space to hide preview)'
      : '(type to filter)';
    const searchStr = searchTerm ? chalk.cyan(searchTerm) : chalk.gray(placeholder);
    const header = [prefix, message, searchStr].filter(Boolean).join(' ');

    const page = usePagination({
      items: results as any,
      active,
      renderItem({ item, isActive }: { item: Choice<T>; isActive: boolean }) {
        if (Separator.isSeparator(item)) return ` ${(item as any).separator}`;
        const cursor = isActive ? chalk.cyan('>') : ' ';
        const row = isActive ? chalk.bold(item.label) : item.label;
        return `${cursor} ${row}`;
      },
      pageSize: cfg.pageSize ?? 10,
      loop: false,
    });

    const enter = cfg.enterHint ?? 'select';
    const help = previewOpen
      ? chalk.gray(`↑↓ navigate · space: close preview · ⏎ ${enter} · esc: cancel`)
      : chalk.gray(
          `↑↓ navigate${hasPreview ? ' · space: preview' : ''} · ⏎ ${enter} · esc: cancel`
        );

    const parts: string[] = [header, page];
    if (results.length === 0) {
      parts.push(chalk.gray(`  ${cfg.emptyMessage ?? 'No matches.'}`));
    }

    if (previewOpen && selected && cfg.buildPreview) {
      const width = terminalWidth();
      const separator = chalk.gray('─'.repeat(Math.min(width, 80)));
      const fixedRows =
        renderedRows(header, width) +
        renderedRows(parts.slice(1).join('\n'), width) +
        renderedRows(separator, width) +
        renderedRows(help, width);
      const availablePreviewRows = terminalRows() - fixedRows;
      const preview = limitPreviewHeight(cfg.buildPreview(selected.value), availablePreviewRows, width);
      if (preview) {
        parts.push(separator);
        parts.push(preview);
      }
    }

    parts.push(help);

    return [header, parts.slice(1).join('\n')];
  });
  return prompt(config);
}
