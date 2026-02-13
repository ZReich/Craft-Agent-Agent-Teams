from pathlib import Path
print(Path('vitest-results-utf8.json').read_bytes()[:20])
