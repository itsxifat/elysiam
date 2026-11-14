import { code128Svg } from '@elysium/domain';

import type { GotenbergAsset, GotenbergClient } from '../../files/pdf/gotenberg.client.js';
import { escposJob, tsplJob, zplJob } from './languages.js';
import { decodePng, encodePng } from './png.js';
import { dotsFor, toMonochrome, type MonoBitmap } from './raster.js';

/**
 * A page made ready for one printer (M46, D-811, D-822): the order's slip or label, or a test
 * page, as a PDF at the printer's paper size (IPP, IPPS, the browser station) or as the
 * printer's own language (raw 9100). The page is drawn once, by M43's templates, and only sized
 * here: scaled down to fit a smaller paper (never up), and for a thermal printer rendered by
 * Chromium's screenshot at the printer's dots and thresholded to one bit a dot.
 */

export interface PrintPage {
  readonly html: string;
  readonly assets: readonly GotenbergAsset[];
  /** The paper the page is drawn on, in millimetres, and the margin printed inside it. */
  readonly widthMm: number;
  readonly heightMm: number;
  readonly marginMm: number;
}

export interface PrinterPaper {
  readonly language: 'pdf' | 'tspl' | 'zpl' | 'escpos';
  readonly widthUm: number;
  readonly heightUm: number;
  readonly dpi: number;
  readonly copies: number;
}

/** How much a page shrinks to fit the paper: at most 1 (never enlarged). */
export function fitScale(page: PrintPage, paper: PrinterPaper): number {
  return Math.min(1, paper.widthUm / 1000 / page.widthMm, paper.heightUm / 1000 / page.heightMm);
}

/** The page with extra CSS added at the end of its styles. */
function withCss(html: string, css: string): string {
  const at = html.indexOf('</style>');
  if (at < 0) return html.replace('</head>', `<style>${css}</style></head>`);
  return `${html.slice(0, at)}\n${css}\n${html.slice(at)}`;
}

const inches = (micrometres: number) => Math.round((micrometres / 25_400) * 1_000_000) / 1_000_000;

/** The bytes to send, and what they are. */
export async function renderForPrinter(
  gotenberg: GotenbergClient,
  page: PrintPage,
  paper: PrinterPaper,
): Promise<{ readonly format: 'pdf' | 'raw'; readonly bytes: Uint8Array }> {
  const scale = fitScale(page, paper);
  if (paper.language === 'pdf') {
    const html =
      scale < 1
        ? withCss(page.html, `html { zoom: ${String(Math.round(scale * 10_000) / 10_000)}; }`)
        : page.html;
    const bytes = await gotenberg.renderPdf({
      html,
      assets: page.assets,
      paperWidth: inches(paper.widthUm),
      paperHeight: inches(paper.heightUm),
      marginInches: inches(page.marginMm * scale * 1000),
    });
    return { format: 'pdf', bytes };
  }
  const bitmap = await pageDots(gotenberg, page, paper, scale);
  const bytes =
    paper.language === 'tspl'
      ? tsplJob(bitmap, { widthUm: paper.widthUm, heightUm: paper.heightUm, copies: paper.copies })
      : paper.language === 'zpl'
        ? zplJob(bitmap, { copies: paper.copies })
        : escposJob(bitmap, { copies: paper.copies });
  return { format: 'raw', bytes };
}

/**
 * The page at the printer's dots, one bit a dot (D-811): Chromium's screenshot at the printer's
 * dpi, thresholded. What a thermal printer's language carries, and what the browser station
 * prints (D-976).
 */
async function pageDots(
  gotenberg: GotenbergClient,
  page: PrintPage,
  paper: PrinterPaper,
  scale: number,
): Promise<MonoBitmap> {
  const widthDots = dotsFor(paper.widthUm, paper.dpi);
  const heightDots = dotsFor(paper.heightUm, paper.dpi);
  // Chromium lays a CSS inch out as 96 px: zoom by dpi / 96 so a millimetre is the printer's
  // dots, then by the fit. The page's own margin becomes padding (a screenshot has no page box).
  const zoom = (paper.dpi / 96) * scale;
  const html = withCss(
    page.html,
    `html { zoom: ${String(Math.round(zoom * 100_000) / 100_000)}; background: #fff; }
     body { padding: ${String(page.marginMm)}mm; }`,
  );
  const png = await gotenberg.screenshotPng({
    html,
    assets: page.assets,
    width: widthDots,
    height: heightDots,
    fullPage: false,
  });
  return toMonochrome(decodePng(png), { widthDots, heightDots });
}

/** One-bit dots as a grey PNG exactly `widthDots` across (the byte padding cut off). */
export function dotsAsPng(bitmap: MonoBitmap, widthDots: number): Uint8Array {
  const width = Math.min(widthDots, bitmap.widthDots);
  const data = new Uint8Array(width * bitmap.heightDots).fill(255);
  for (let y = 0; y < bitmap.heightDots; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const byte = bitmap.rows[y * bitmap.widthBytes + (x >> 3)] ?? 0;
      if (byte & (0x80 >> (x & 7))) data[y * width + x] = 0;
    }
  }
  return encodePng({ width, height: bitmap.heightDots, channels: 1, data });
}

/**
 * The page as a picture for the browser print station (D-976): black and white at the printer's
 * own dots per inch, so the browser's print maps one pixel to one dot on a thermal printer.
 * Chrome's `print()` of a PDF in a frame returns before its dialog closes (and the viewer is
 * refused under the console's `object-src 'none'`); an HTML page of pictures prints the way a
 * page does, and many labels go in one dialog.
 */
export async function renderPictureForBrowser(
  gotenberg: GotenbergClient,
  page: PrintPage,
  paper: PrinterPaper,
): Promise<Uint8Array> {
  const bitmap = await pageDots(gotenberg, page, paper, fitScale(page, paper));
  return dotsAsPng(bitmap, dotsFor(paper.widthUm, paper.dpi));
}

const escape = (value: string) =>
  value.replace(/[&<>"']/g, (char) => `&#${String(char.charCodeAt(0))};`);

/**
 * A printer's test page (D-815): its name, terminal, paper and the time, a border at the paper's
 * edge to see the alignment, and a Code 128 to try the scanners on. No brand on it.
 */
export function testPage(input: {
  readonly printerName: string;
  readonly terminalName: string;
  readonly widthUm: number;
  readonly heightUm: number;
  readonly dpi: number;
  readonly at: string;
}): PrintPage {
  const widthMm = input.widthUm / 1000;
  const heightMm = input.heightUm / 1000;
  const barcode = code128Svg('TEST-PRINT', 40).replace(
    '<svg ',
    `<svg width="${String(Math.min(60, widthMm - 12))}mm" height="12mm" `,
  );
  const html = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>Test print</title>
    <style>
      @page { size: ${String(widthMm)}mm ${String(heightMm)}mm; margin: 0; }
      * { box-sizing: border-box; }
      html { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
      body { margin: 0; font-family: sans-serif; color: #000; }
      .sheet { width: ${String(widthMm)}mm; height: ${String(heightMm - 0.2)}mm; border: 1.5pt solid #000; padding: 4mm; overflow: hidden; }
      h1 { margin: 0 0 3mm; font-size: 18pt; }
      dl { margin: 0; display: grid; grid-template-columns: auto 1fr; gap: 1mm 3mm; font-size: 10pt; }
      dt { font-weight: 700; }
      .bars { margin-top: 4mm; line-height: 0; }
    </style>
  </head>
  <body>
    <div class="sheet">
      <h1>Test print</h1>
      <dl>
        <dt>Printer</dt><dd>${escape(input.printerName)}</dd>
        <dt>Terminal</dt><dd>${escape(input.terminalName)}</dd>
        <dt>Paper</dt><dd>${String(Math.round(widthMm))} × ${String(Math.round(heightMm))} mm, ${String(input.dpi)} dpi</dd>
        <dt>Sent</dt><dd>${escape(input.at)}</dd>
      </dl>
      <div class="bars">${barcode}</div>
    </div>
  </body>
</html>`;
  return { html, assets: [], widthMm, heightMm, marginMm: 0 };
}
