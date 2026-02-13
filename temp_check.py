from pathlib import Path
text = Path('vitest-results.json').read_text()
print(len(text))
print(text[:100])
