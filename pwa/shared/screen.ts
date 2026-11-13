// Things read off an agent's terminal screen because nothing else reports them.
// Screen layouts are the agent's own and can change: every reader here returns null when unsure.

/**
 * What Claude Code's input box (the line between two rules) holds: '' when empty, null when no box
 * is on screen, as when a picker such as /resume's or a dialog has taken its place.
 */
export function claudeInput(screen: string): string | null {
  const lines = screen.split('\n').map((l) => l.replace(/\s+$/, ''));
  const rule = (l: string | undefined) => !!l && /^─{8,}/.test(l);
  for (let i = lines.length - 1; i > 0; i--) {
    // The marker is followed by a no-break space; an empty box is the marker alone.
    const box = lines[i].match(/^❯(?:[ \u00a0](.*))?$/);
    if (!box || !rule(lines[i - 1])) continue;
    const parts = [box[1] ?? ''];
    let j = i + 1;
    for (; j < lines.length && !rule(lines[j]); j++) parts.push(lines[j].trim()); // wrapped onto more rows
    if (!rule(lines[j])) return null; // not the input box
    return parts.join(' ').trim();
  }
  return null;
}

/**
 * Claude Code's suggested next prompt: the text it shows in its input box.
 * Text a person typed there looks the same in plain text, and is as good a thing to offer.
 */
export const claudeSuggestion = (screen: string): string | null => claudeInput(screen) || null;
