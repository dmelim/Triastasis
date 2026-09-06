#!/usr/bin/env python3
"""Call app-owned Library recovery. Never reads or copies Library files locally."""
import argparse
import json
import sys
import urllib.request
from pathlib import Path

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--api', default='http://127.0.0.1:8082')
commands = parser.add_subparsers(dest='command', required=True)
scan = commands.add_parser('scan')
scan.add_argument('--source-dir', required=True, help='Absolute Library path as seen by Triastasis')
scan.add_argument('--report', required=True, help='New JSON report file')
recover = commands.add_parser('recover')
recover.add_argument('--report', required=True)
selection = recover.add_mutually_exclusive_group(required=True)
selection.add_argument('--id', action='append', help='Record ID from the scan (repeatable)')
selection.add_argument('--all-missing', action='store_true')
args = parser.parse_args()

def call(endpoint, payload):
    request = urllib.request.Request(args.api.rstrip('/') + endpoint,
        data=json.dumps(payload).encode(), headers={'Content-Type': 'application/json'})
    with urllib.request.urlopen(request, timeout=600) as response:
        return json.load(response)

try:
    if args.command == 'scan':
        # Refuse to overwrite a previous review report.
        with Path(args.report).open('x', encoding='utf-8') as output:
            result = call('/library/recovery/scan', {'sourcePath': args.source_dir})
            json.dump(result, output, indent=2)
    else:
        report = json.loads(Path(args.report).read_text(encoding='utf-8'))
        entries = [r for r in report['records'] if r['status'] == 'missing'
                   and (args.all_missing or r['id'] in args.id)]
        if args.id and set(args.id) != {r['id'] for r in entries}:
            raise ValueError('Every selected ID must be marked missing in this report')
        if not entries:
            raise ValueError('No missing records selected')
        result = call('/library/recovery/recover', {'sourcePath': report['sourcePath'],
            'records': [{'id': r['id'], 'fingerprint': r['fingerprint']} for r in entries]})
    print(json.dumps(result, indent=2))
    if any(r['status'] in ('failed', 'conflict') for r in result.get('results', [])):
        sys.exit(2)
except Exception as error:
    print(str(error), file=sys.stderr)
    sys.exit(1)
