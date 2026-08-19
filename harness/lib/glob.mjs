/**
 * Minimal glob-to-regex for adapter-supplied path patterns
 * (project-adapter.yml's `constitution.create_only_paths`, and similar).
 * Not a general-purpose glob library — just enough to turn
 * "tests/game-logic/*.test.js" into the equivalent of what carrotgame wrote
 * by hand as a raw regex, without asking every adapter author to write
 * regex literals in YAML.
 *
 * Supported: `*` (any run of characters except `/`), `**` (any run of
 * characters including `/`), everything else is escaped literally.
 */
export function globToRegExp(glob) {
  let out = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        out += '.*';
        i++;
      } else {
        out += '[^/]*';
      }
    } else if ('.+^${}()|[]\\'.includes(c)) {
      out += '\\' + c;
    } else {
      out += c;
    }
  }
  return new RegExp(`^${out}$`);
}
