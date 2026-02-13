import json
from pathlib import Path
j=json.loads(Path('vitest-results.json').read_text(encoding='utf-8', errors='ignore'))
print(f"total={j['numTotalTests']} passed={j['numPassedTests']} failed={j['numFailedTests']} failedSuites={j['numFailedTestSuites']}")
for s in j['testResults']:
  if s.get('status')=='failed':
    fails=[a for a in s.get('assertionResults',[]) if a.get('status')=='failed']
    print(f"{s['name']} :: {len(fails)}")
