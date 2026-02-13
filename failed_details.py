import json
from pathlib import Path
j=json.loads(Path('vitest-results.json').read_text(encoding='utf-8', errors='ignore'))
for suite in j['testResults']:
    fails=[a for a in suite.get('assertionResults',[]) if a.get('status')=='failed']
    if fails:
        print('\n' + suite['name'])
        for a in fails:
            msg=(a.get('failureMessages') or [''])[0].split('\n')[0]
            print('-', a['fullName'])
            print('  ', msg)
