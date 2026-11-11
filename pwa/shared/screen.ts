// Things read off an agent's terminal screen because nothing else reports them.
// Screen layouts are the agent's own and can change: every reader here returns null when unsure.

/**
 * Claude Code's suggested next prompt: the text it shows in its input box, between two rules.
 * Text a person typed there looks the same in plain text, and is as good a thing to offer.
 */
export function claudeSuggestion(screen: string): string | null {
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
    const text = parts.join(' ').trim();
    return text || null;
  }
  return null;
}
