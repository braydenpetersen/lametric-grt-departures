"""Refresh compact Worker data from the two official GRT GTFS feeds.
Run: python3 scripts/refresh-schedule.py [--cached]
"""
import csv, io, json, sys, urllib.request, zipfile
from collections import defaultdict
from datetime import datetime, timedelta, timezone
from pathlib import Path
ROOT = Path(__file__).resolve().parent.parent
cache = ROOT / 'work'
cache.mkdir(exist_ok=True)
schedule = {}; dates = defaultdict(set); stops = {}
for feed, number in [('bus', 1), ('lrt', 2)]:
    target = cache / f'grt-{feed}.zip'
    if '--cached' not in sys.argv:
        urllib.request.urlretrieve(f'https://webapps.regionofwaterloo.ca/api/grt-routes/api/staticfeeds/{number}', target)
    with zipfile.ZipFile(target) as z:
        def rows(name):
            if name not in z.namelist(): return []
            return csv.DictReader(io.TextIOWrapper(z.open(name), encoding='utf-8-sig'))
        prefix = feed + ':'
        for r in rows('calendar.txt'):
            day = datetime.strptime(r['start_date'], '%Y%m%d')
            end = datetime.strptime(r['end_date'], '%Y%m%d')
            weekdays = ['monday','tuesday','wednesday','thursday','friday','saturday','sunday']
            while day <= end:
                if r[weekdays[day.weekday()]] == '1': dates[day.strftime('%Y%m%d')].add(prefix+r['service_id'])
                day += timedelta(days=1)
        for r in rows('calendar_dates.txt'):
            service = prefix+r['service_id']
            if r['exception_type'] == '1': dates[r['date']].add(service)
            else: dates[r['date']].discard(service)
        active = {s for values in dates.values() for s in values}
        routes = {r['route_id']:r['route_short_name'] for r in rows('routes.txt')}
        trips = {r['trip_id']:(prefix+r['service_id'], routes[r['route_id']]) for r in rows('trips.txt') if prefix+r['service_id'] in active}
        for r in rows('stops.txt'):
            if r.get('location_type','0') in ('','0'):
                stops[r['stop_id']] = {'id':r['stop_id'], 'name':f"({r.get('stop_code') or r['stop_id']}) {r['stop_name']}"}
        for r in rows('stop_times.txt'):
            if r['trip_id'] not in trips: continue
            service, route = trips[r['trip_id']]
            time = r['departure_time'] or r['arrival_time']
            if not time: continue
            h,m,*_ = time.split(':')
            schedule.setdefault(service,{}).setdefault(r['stop_id'],{}).setdefault(route,set()).add(f'{int(h):02d}:{m}')
for service in schedule.values():
    for stop in service.values():
        for route in stop: stop[route] = sorted(stop[route])
active_dates = {d:sorted(s) for d,s in sorted(dates.items()) if s}
if not active_dates: raise SystemExit('Empty GTFS calendar; refusing to replace data')
today = datetime.now(timezone.utc).strftime('%Y%m%d')
if max(active_dates) < today: raise SystemExit('Downloaded GTFS is expired; refusing to replace data')
for name, data in [('schedule.json',schedule),('service-dates.json',active_dates),('stops.json',sorted(stops.values(),key=lambda x:int(x['id']) if x['id'].isdigit() else 999999))]:
    (ROOT/'data'/name).write_text(json.dumps(data,separators=(',',':'))+'\n')
print(f'Refreshed {len(stops)} stops, {len(schedule)} services; valid {min(active_dates)}–{max(active_dates)}')
