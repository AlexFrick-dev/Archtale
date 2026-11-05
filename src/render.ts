import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rename, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

/** Путь к draw.io: явный `--drawio`, стандартные места установки, иначе имя из PATH. */
export function resolveDrawio(explicit?: string): string {
  if (explicit) return explicit;
  const candidates = [
    process.env.ProgramFiles && path.join(process.env.ProgramFiles, "draw.io", "draw.io.exe"),
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, "Programs", "draw.io", "draw.io.exe"),
    "/Applications/draw.io.app/Contents/MacOS/draw.io",
  ];
  return candidates.find((c): c is string => !!c && existsSync(c)) ?? "drawio";
}

/** Перерисовывает файл на месте; XML диаграммы встраивается обратно. Возвращает false, если draw.io не найден. */
export async function renderInPlace(file: string, drawio: string): Promise<boolean> {
  const dir = await mkdtemp(path.join(tmpdir(), "archtale-"));
  const out = path.join(dir, "out.drawio.svg");
  try {
    // Без --theme light CLI пишет адаптивные цвета, и превью в тёмной теме их инвертирует.
    await run(drawio, ["-x", "-f", "svg", "--embed-diagram", "--theme", "light", "-o", out, file]);
    if (!(await stat(out)).size) throw new Error(`draw.io вернул пустой файл для ${file}`);
    await rename(out, file);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT" && !existsSync(out)) {
      if (!isCommandMissing(drawio)) throw new Error(`draw.io не создал файл для ${file}`);
      return false;
    }
    throw error;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// Имя из PATH или указанный путь, которого нет на диске: запускать нечего.
function isCommandMissing(drawio: string): boolean {
  return !existsSync(drawio);
}
