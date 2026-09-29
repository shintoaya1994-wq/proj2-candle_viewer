// One picture of all the charts of a window.

export interface Tile {
  title: string;
  /** The chart as a data URL. */
  picture: string;
}

const GAP = 6;
const HEADER = 22;

function load(source: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error('a chart could not be drawn'));
    image.src = source;
  });
}

/** Puts the charts side by side as they are on the screen, each below its title. */
export async function compose(tiles: Tile[], columns: number): Promise<string | null> {
  const drawn = tiles.filter((tile) => tile.picture !== '');
  if (drawn.length === 0) return null;

  const images = await Promise.all(drawn.map((tile) => load(tile.picture)));
  const ratio = window.devicePixelRatio || 1;
  const width = Math.max(...images.map((image) => image.width));
  const height = Math.max(...images.map((image) => image.height));
  const header = Math.round(HEADER * ratio);
  const gap = Math.round(GAP * ratio);
  const across = Math.max(1, Math.min(columns, drawn.length));
  const down = Math.ceil(drawn.length / across);

  const canvas = document.createElement('canvas');
  canvas.width = across * width + (across + 1) * gap;
  canvas.height = down * (height + header) + (down + 1) * gap;
  const context = canvas.getContext('2d');
  if (!context) return null;
  context.fillStyle = '#e5e9ee';
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.textBaseline = 'middle';
  context.font = `${Math.round(13 * ratio)}px system-ui, "Noto Sans CJK SC", "Microsoft YaHei", sans-serif`;

  images.forEach((image, index) => {
    const x = gap + (index % across) * (width + gap);
    const y = gap + Math.floor(index / across) * (height + header + gap);
    context.fillStyle = '#ffffff';
    context.fillRect(x, y, width, height + header);
    context.fillStyle = '#1f2933';
    context.fillText(drawn[index]?.title ?? '', x + Math.round(8 * ratio), y + header / 2);
    context.drawImage(image, x, y + header);
  });
  return canvas.toDataURL('image/png');
}
