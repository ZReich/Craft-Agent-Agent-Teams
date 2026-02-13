import json
from pathlib import Path
path = Path('vitest-results-clean.json')
data = json.loads(path.read_text(encoding='utf-8-sig'))
print('TOTAL SUITES {} PASS {} FAIL {} SKIPPED {}'.format(data['numTotalTestSuites'], data['numPassedTestSuites'], data['numFailedTestSuites'], data['numPendingTestSuites']))
print('TOTAL TESTS {} PASS {} FAIL {} SKIPPED {}'.format(data['numTotalTests'], data['numPassedTests'], data['numFailedTests'], data['numPendingTests']))
failures = []
for suite in data.get('testResults', []):
    suite_name = suite['name']
    for assertion in suite['assertionResults']:
        if assertion['status'] == 'failed':
            msg = '\n'.join(assertion.get('failureMessages', []))
            failures.append({'suite': suite_name, 'fullName': assertion['fullName'], 'message': msg})
print('FAILURE COUNT', len(failures))
print('E2E FILE STATUS:')
for suite in data.get('testResults', []):
    if 'e2e-quality-orchestration.test.ts' in suite['name']:
        print('  ', suite['name'], suite['status'])
        break
print('\nFAILURES:')
for failure in failures:
    first_line = failure['message'].split('\n', 1)[0] if failure['message'] else 'No message'
    print(f"- {failure['fullName']}: {first_line}")
