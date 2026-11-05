import assert from 'node:assert/strict';
import type { Page } from 'playwright-core';

/**
 * The Simplified-Chinese UI gate shared by the shipped UI certification and the
 * release certification: one page must carry one Chinese heading, state its
 * language, render no English user-facing copy, meet WCAG 2.2 AA contrast, and
 * label every form control.
 */

export interface CopyLeak {
  tag: string;
  text: string;
  attribute?: string;
}

/**
 * Scans the rendered page for English user-facing copy. Machine values stay
 * exempt only when they are single identifiers, not English sentences; a
 * Chinese sentence may name one brand or acronym, but not carry English prose.
 */
export async function copyLeaks(page: Page): Promise<CopyLeak[]> {
  return page.evaluate(() => {
    const CJK = /[\u4e00-\u9fff]/u;
    const SKIP = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'OPTION', 'TEXTAREA']);
    // Table headers may name governed fields, so a single identifier is allowed
    // there; every other copy role rejects even a one-word English label.
    const STRICT = new Set(['H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'BUTTON', 'A', 'LABEL', 'DT', 'SUMMARY', 'CAPTION']);
    const ATTRIBUTES = ['aria-label', 'aria-description', 'title', 'placeholder', 'alt'];

    const looksLikeToken = (text: string): boolean =>
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(text)
      || /[/_:@\\]/u.test(text)
      || /^[a-z][a-z0-9]*(?:-[a-z0-9]+)+$/u.test(text)
      || /^[a-z][A-Za-z0-9_-]*(?:\.[A-Za-z0-9_-]+)+\.?$/u.test(text)
      || /^[A-Z0-9][A-Z0-9 .%+\-–—/]*$/u.test(text);

    const englishWords = (text: string): string[] =>
      (text.match(/[A-Za-z][A-Za-z'-]*/gu) ?? []).filter((word) => word.length >= 3 && /[a-z]/u.test(word));

    const leaks = (text: string, strict: boolean): boolean => {
      const value = text.replace(/\s+/gu, ' ').trim();
      if (value === '' || /^\d[\d\s.,:%+-]*$/u.test(value)) return false;
      const words = englishWords(value);
      if (words.length === 0) return false;
      if (looksLikeToken(value)) return false;
      if (CJK.test(value)) return words.length >= 2;
      return strict ? words.length >= 1 : words.length >= 2;
    };

    const visible = (element: Element): boolean => {
      if (element.closest('[aria-hidden="true"]') !== null) return false;
      const style = getComputedStyle(element);
      if (style.display === 'none' || style.visibility !== 'visible' || Number(style.opacity) === 0) return false;
      const rect = element.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    };

    const found: CopyLeak[] = [];
    for (const element of document.querySelectorAll('body *')) {
      if (SKIP.has(element.tagName) || !visible(element)) continue;
      let text = '';
      for (const child of element.childNodes) {
        if (child.nodeType === Node.TEXT_NODE) text += child.textContent ?? '';
      }
      text = text.replace(/\s+/gu, ' ').trim();
      if (text !== '' && leaks(text, STRICT.has(element.tagName))) {
        found.push({ tag: element.tagName, text: text.slice(0, 120) });
      }
      for (const attribute of ATTRIBUTES) {
        const value = element.getAttribute(attribute);
        if (value !== null && leaks(value, true)) {
          found.push({ tag: element.tagName, attribute, text: value.slice(0, 120) });
        }
      }
    }
    return found;
  });
}

export interface ContrastFailure {
  tag: string;
  text: string;
  ratio: number;
  color: string;
  background: string;
}

/** WCAG 2.2 AA: 4.5:1 for normal text and 3:1 for large text. */
export async function contrastFailures(page: Page): Promise<ContrastFailure[]> {
  return page.evaluate(() => {
    interface Rgba { r: number; g: number; b: number; a: number }
    const SKIP = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'OPTION', 'TEXTAREA']);

    const parse = (value: string): Rgba | null => {
      const match = /^rgba?\(([^)]+)\)$/u.exec(value);
      if (match === null) return null;
      const parts = (match[1] ?? '').split(',').map((part) => Number(part.trim()));
      if (parts.length < 3) return null;
      return { r: parts[0] ?? 0, g: parts[1] ?? 0, b: parts[2] ?? 0, a: parts[3] ?? 1 };
    };
    const over = (top: Rgba, bottom: Rgba): Rgba => ({
      r: top.r * top.a + bottom.r * (1 - top.a),
      g: top.g * top.a + bottom.g * (1 - top.a),
      b: top.b * top.a + bottom.b * (1 - top.a),
      a: 1,
    });
    const channel = (value: number): number => {
      const scaled = value / 255;
      return scaled <= 0.03928 ? scaled / 12.92 : ((scaled + 0.055) / 1.055) ** 2.4;
    };
    const luminance = (color: Rgba): number =>
      0.2126 * channel(color.r) + 0.7152 * channel(color.g) + 0.0722 * channel(color.b);
    const ratio = (left: Rgba, right: Rgba): number => {
      const first = luminance(left);
      const second = luminance(right);
      return (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05);
    };
    const backgroundOf = (element: Element): Rgba => {
      const chain: Element[] = [];
      for (let node: Element | null = element; node !== null; node = node.parentElement) chain.push(node);
      let background: Rgba = { r: 255, g: 255, b: 255, a: 1 };
      for (const node of chain.reverse()) {
        const color = parse(getComputedStyle(node).backgroundColor);
        if (color !== null && color.a > 0) background = over(color, background);
      }
      return background;
    };
    const visible = (element: Element): boolean => {
      if (element.closest('[aria-hidden="true"]') !== null) return false;
      if (element.closest('button:disabled, input:disabled, select:disabled') !== null) return false;
      const style = getComputedStyle(element);
      if (style.display === 'none' || style.visibility !== 'visible' || Number(style.opacity) === 0) return false;
      const rect = element.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    };

    const failures: ContrastFailure[] = [];
    for (const element of document.querySelectorAll('body *')) {
      if (SKIP.has(element.tagName) || !visible(element)) continue;
      let text = '';
      for (const child of element.childNodes) {
        if (child.nodeType === Node.TEXT_NODE) text += child.textContent ?? '';
      }
      text = text.replace(/\s+/gu, ' ').trim();
      if (text === '') continue;
      const style = getComputedStyle(element);
      const foreground = parse(style.color);
      if (foreground === null) continue;
      const background = backgroundOf(element);
      const effective = over(foreground, background);
      const value = ratio(effective, background);
      const size = Number.parseFloat(style.fontSize);
      const weight = Number.parseInt(style.fontWeight, 10) || 400;
      const large = size >= 24 || (size >= 18.66 && weight >= 700);
      const required = large ? 3 : 4.5;
      if (value < required - 0.01) {
        failures.push({
          tag: element.tagName,
          text: text.slice(0, 80),
          ratio: Math.round(value * 100) / 100,
          color: style.color,
          background: `rgb(${Math.round(background.r)}, ${Math.round(background.g)}, ${Math.round(background.b)})`,
        });
      }
    }
    return failures;
  });
}

/** Every form control must have a programmatic name before it can be used by keyboard or SR. */
export async function unlabeledControls(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const missing: string[] = [];
    for (const control of document.querySelectorAll('input, select, textarea')) {
      const element = control as HTMLInputElement;
      if (element.type === 'hidden') continue;
      const label = element.labels?.[0]?.textContent?.trim()
        ?? element.getAttribute('aria-label')
        ?? element.getAttribute('aria-labelledby')?.split(/\s+/u)
          .map((id) => document.getElementById(id)?.textContent ?? '')
          .join(' ')
          .trim();
      if (label === undefined || label === '') missing.push(element.id || element.name || element.tagName);
    }
    return missing;
  });
}

/** The recorded outcome of one page-level Chinese-and-accessibility gate. */
export interface ChinesePageReport {
  heading: string;
  passed: boolean;
  copy_leaks: CopyLeak[];
  contrast_failures: ContrastFailure[];
  unlabeled_controls: string[];
  failures: string[];
}

/**
 * Inspects one surface without throwing, so certification can record every
 * surface result rather than stopping at the first failure.
 */
export async function inspectChineseSurface(page: Page, heading: string): Promise<ChinesePageReport> {
  const failures: string[] = [];
  const h1 = page.getByRole('heading', { level: 1, name: heading, exact: true });
  try {
    await h1.waitFor();
  } catch {
    failures.push(`one page heading reads ${heading}`);
  }
  const lang = await page.locator('html').getAttribute('lang');
  if (lang !== 'zh-CN') failures.push(`the document language is ${String(lang)}, not zh-CN`);
  if (!/[\u4e00-\u9fff]/u.test(await page.title())) failures.push('the document title is not Chinese');
  const headings = await page.getByRole('heading', { level: 1 }).count();
  if (headings !== 1) failures.push(`${headings} level-one headings are rendered`);
  const leaks = await copyLeaks(page);
  if (leaks.length > 0) failures.push(`${leaks.length} English user-facing copy leaks`);
  const contrast = await contrastFailures(page);
  if (contrast.length > 0) failures.push(`${contrast.length} text elements fail WCAG 2.2 AA contrast`);
  const unlabeled = await unlabeledControls(page);
  if (unlabeled.length > 0) failures.push(`${unlabeled.length} form controls have no programmatic label`);
  return {
    heading,
    passed: failures.length === 0,
    copy_leaks: leaks,
    contrast_failures: contrast,
    unlabeled_controls: unlabeled,
    failures,
  };
}

/** Proves one surface: one Chinese document heading, Chinese copy, AA contrast, labelled controls. */
export async function assertChineseSurface(page: Page, heading: string): Promise<void> {
  const report = await inspectChineseSurface(page, heading);
  assert.deepEqual(report.copy_leaks, [], `${page.url()}: English user-facing copy remains`);
  assert.deepEqual(report.contrast_failures, [], `${page.url()}: text fails WCAG 2.2 AA contrast`);
  assert.deepEqual(report.unlabeled_controls, [], `${page.url()}: form controls have no programmatic label`);
  assert.deepEqual(report.failures, [], page.url());
}

/** Tabs through the page and proves each focused control shows a visible focus indicator. */
export async function assertKeyboardFocus(page: Page, steps: number): Promise<void> {
  await page.locator('body').click({ position: { x: 4, y: 4 } });
  await page.keyboard.press('Tab');
  for (let step = 0; step < steps; step += 1) {
    const focused = await page.evaluate(() => {
      const element = document.activeElement as HTMLElement | null;
      if (element === null || element === document.body) return null;
      const style = getComputedStyle(element);
      return {
        tag: element.tagName,
        text: (element.textContent ?? '').trim().slice(0, 40),
        outline: style.outlineStyle,
        outlineWidth: style.outlineWidth,
        shadow: style.boxShadow,
      };
    });
    assert.ok(focused !== null, 'Tab moves focus into the page');
    assert.ok(
      (focused.outline !== 'none' && focused.outlineWidth !== '0px') || focused.shadow !== 'none',
      `${focused.tag} ${JSON.stringify(focused.text)} has no visible focus indicator`,
    );
    await page.keyboard.press('Tab');
  }
}
