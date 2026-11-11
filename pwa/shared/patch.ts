// A git patch split into files, for the changes view.
export type DiffLine = { kind: 'add' | 'del' | 'ctx' | 'hunk' | 'meta'; text: string };
export type FileDiff = { path: string; added: number; removed: number; binary: boolean; lines: DiffLine[] };

export function parsePatch(patch: string): FileDiff[] {
  const files: FileDiff[] = [];
  let cur: FileDiff | null = null, inHunk = false;
  for (const line of patch.split('\n')) {
    if (line.startsWith('diff --git ')) {
      // "a/x b/x": the two halves are the same path unless renamed, which we ask git not to report.
      const rest = line.slice(11), half = (rest.length - 1) / 2;
      const path = Number.isInteger(half) && rest.slice(0, half).slice(2) === rest.slice(half + 1).slice(2) ? rest.slice(half + 3) : rest.replace(/^a\//, '');
      cur = { path, added: 0, removed: 0, binary: false, lines: [] };
      files.push(cur);
      inHunk = false;
    } else if (!cur) {
      continue;
    } else if (line.startsWith('@@')) {
      inHunk = true;
      cur.lines.push({ kind: 'hunk', text: line });
    } else if (!inHunk) {
      if (line.startsWith('+++ b/')) cur.path = line.slice(6); // the surest name for the file
      else if (line.startsWith('Binary files') || line.startsWith('GIT binary patch')) cur.binary = true;
    } else if (line.startsWith('+')) { cur.added++; cur.lines.push({ kind: 'add', text: line.slice(1) }); }
    else if (line.startsWith('-')) { cur.removed++; cur.lines.push({ kind: 'del', text: line.slice(1) }); }
    else if (line.startsWith('\\')) cur.lines.push({ kind: 'meta', text: line.slice(2) });
    else if (line.startsWith(' ')) cur.lines.push({ kind: 'ctx', text: line.slice(1) });
  }
  return files;
}
