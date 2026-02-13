import json
from pathlib import Path
text = Path('vitest-results.json').read_text(encoding='utf-16-le', errors='ignore')
data = json.loads(text)
print(data['numFailedTests'])
