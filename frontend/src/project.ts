// The project whose records a window works on. Windows opened from the main window get it from their address.

const KEY = 'candle-viewer.project';
/** The main records at the root of the workspace. */
export const MAIN = '';
let current: string | null = null;

export function currentProject(): string {
  if (current === null) {
    try {
      current = window.localStorage.getItem(KEY) ?? MAIN;
    } catch {
      current = MAIN;
    }
  }
  return current;
}

export function setProject(name: string): void {
  current = name;
  try {
    window.localStorage.setItem(KEY, name);
  } catch {
    // The window keeps the project for as long as it is open.
  }
}

/** The header that tells the program which project; names are percent-encoded because headers are ASCII. */
export function projectHeader(): Record<string, string> {
  const name = currentProject();
  return name === MAIN ? {} : { 'x-project': encodeURIComponent(name) };
}

export const projectLabel = (name: string) => (name === MAIN ? '主项目' : name);

/** The project of this window as a route carries it: null for the main records. */
export const here = (): string | null => currentProject() || null;
