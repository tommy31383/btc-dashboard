import {
  CustomData,
  CustomSeriesOptions,
  CustomSeriesPricePlotValues,
  CustomSeriesWhitespaceData,
  ICustomSeriesPaneRenderer,
  ICustomSeriesPaneView,
  PaneRendererCustomData,
  PriceToCoordinateConverter,
  Time,
  customSeriesDefaultOptions,
} from "lightweight-charts";
import { CanvasRenderingTarget2D } from "fancy-canvas";

export interface VolumeCandleData extends CustomData<Time> {
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface VolumeCandleSeriesOptions extends CustomSeriesOptions {
  upColor: string;
  downColor: string;
  wickColor: string;
}

const defaultVolumeCandleOptions: VolumeCandleSeriesOptions = {
  ...customSeriesDefaultOptions,
  upColor: "#26a69a",
  downColor: "#ef5350",
  wickColor: "#999999",
};

class VolumeCandleRenderer implements ICustomSeriesPaneRenderer {
  private _data: PaneRendererCustomData<Time, VolumeCandleData> | null = null;
  private _options: VolumeCandleSeriesOptions = defaultVolumeCandleOptions;

  update(data: PaneRendererCustomData<Time, VolumeCandleData>, options: VolumeCandleSeriesOptions): void {
    this._data = data;
    this._options = options;
  }

  draw(target: CanvasRenderingTarget2D, priceConverter: PriceToCoordinateConverter, _isHovered: boolean, _hitTestData?: unknown): void {
    if (!this._data || !this._data.visibleRange) return;
    const { bars, barSpacing, visibleRange, conflationFactor } = this._data;

    // A bar slot can have no originalData under conflation (zoomed far out,
    // multiple data points combined) — optional-chain the whole bar first.
    let visibleMaxVolume = 0;
    for (let i = visibleRange.from; i < visibleRange.to; i++) {
      const vol = bars[i]?.originalData?.volume ?? 0;
      if (vol > visibleMaxVolume) visibleMaxVolume = vol;
    }
    if (visibleMaxVolume <= 0) return;

    const effectiveBarSpacing = barSpacing * conflationFactor;

    target.useBitmapCoordinateSpace((scope) => {
      const { context, horizontalPixelRatio, verticalPixelRatio } = scope;
      for (let i = visibleRange.from; i < visibleRange.to; i++) {
        const bar = bars[i];
        const row = bar?.originalData;
        if (!bar || !row) continue;
        const isUp = row.close >= row.open;
        const color = isUp ? this._options.upColor : this._options.downColor;

        const rawWidth = effectiveBarSpacing * (row.volume / visibleMaxVolume);
        const bodyWidthMedia = Math.max(1, Math.min(rawWidth, effectiveBarSpacing * 1.0));
        const bodyWidthBitmap = Math.round(bodyWidthMedia * horizontalPixelRatio);
        const xBitmap = Math.round(bar.x * horizontalPixelRatio);

        // priceConverter returns Coordinate | null (media/CSS coordinate) —
        // must null-guard before use.
        const highY = priceConverter(row.high);
        const lowY = priceConverter(row.low);
        const openY = priceConverter(row.open);
        const closeY = priceConverter(row.close);
        if (highY === null || lowY === null || openY === null || closeY === null) continue;

        const highYBitmap = Math.round(highY * verticalPixelRatio);
        const lowYBitmap = Math.round(lowY * verticalPixelRatio);
        const openYBitmap = Math.round(openY * verticalPixelRatio);
        const closeYBitmap = Math.round(closeY * verticalPixelRatio);
        const bodyTop = Math.min(openYBitmap, closeYBitmap);
        const bodyBottom = Math.max(openYBitmap, closeYBitmap);

        // Wick — fixed 1px (device-independent) width regardless of volume
        context.fillStyle = color;
        const wickWidthBitmap = Math.max(1, Math.round(horizontalPixelRatio));
        context.fillRect(xBitmap - Math.floor(wickWidthBitmap / 2), highYBitmap, wickWidthBitmap, lowYBitmap - highYBitmap);

        // Body — width varies with volume
        context.fillRect(
          xBitmap - Math.floor(bodyWidthBitmap / 2),
          bodyTop,
          bodyWidthBitmap,
          Math.max(1, bodyBottom - bodyTop)
        );
      }
    });
  }
}

export class VolumeCandleSeries implements ICustomSeriesPaneView<Time, VolumeCandleData, VolumeCandleSeriesOptions> {
  private _renderer = new VolumeCandleRenderer();

  renderer(): ICustomSeriesPaneRenderer {
    return this._renderer;
  }

  update(data: PaneRendererCustomData<Time, VolumeCandleData>, options: VolumeCandleSeriesOptions): void {
    this._renderer.update(data, options);
  }

  priceValueBuilder(row: VolumeCandleData): CustomSeriesPricePlotValues {
    return [row.high, row.low, row.close];
  }

  isWhitespace(data: VolumeCandleData | CustomSeriesWhitespaceData<Time>): data is CustomSeriesWhitespaceData<Time> {
    return !("open" in data);
  }

  defaultOptions(): VolumeCandleSeriesOptions {
    return defaultVolumeCandleOptions;
  }
}
