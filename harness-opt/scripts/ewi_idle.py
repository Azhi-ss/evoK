"""EWI idle-after-write metrics for a run dir (read-only). usage: ewi_idle.py <run_dir>"""
import csv,json,os,re,sys,datetime as D
R=sys.argv[1]; done={}
for l in open(f'{R}/batch.log'):
    m=re.match(r'(\S+) run (\d+) done',l)
    if m: done[int(m.group(2))]=D.datetime.fromisoformat(m.group(1)).timestamp()
def ts_of(rec):
    # Same failure as a missing key: bool, NaN, ±Inf, str, null, list, object.
    if not isinstance(rec, dict):
        raise TypeError('trace line is not an object')
    if rec.get('type')!='assistant_message':
        return None
    if 'ts' not in rec:
        raise KeyError('missing ts')
    ts=rec['ts']
    if isinstance(ts, bool) or not isinstance(ts, (int, float)) or ts!=ts or ts==float('inf') or ts==float('-inf'):
        raise KeyError('missing ts')
    return ts/1000
def am_ts(tr):
    out=[]
    # open() uses universal newlines, so a lone CR splits the same way Python does.
    for x in open(tr):
        try:
            rec=json.loads(x)
        except json.JSONDecodeError:
            raise SystemExit('trace line is not JSON')
        try:
            stamp=ts_of(rec)
        except TypeError:
            raise SystemExit('trace line is not an object')
        except KeyError:
            raise SystemExit('assistant_message is missing ts')
        if stamp is not None:
            out.append(stamp)
    return out
out=[]
for i,r in enumerate(csv.DictReader(open(f'{R}/summary.csv')),2):
    tr=r['trace']; od=os.path.join(os.path.dirname(tr),'outputs')
    tw=max(os.path.getmtime(os.path.join(a,f)) for a,_,b in os.walk(od) for f in b)
    am=am_ts(tr)
    after=[t for t in am if t>tw]; tend=done[int(r['n'])]
    pts=[tw]+after+[tend]; gap=max(b-a for a,b in zip(pts,pts[1:]))
    out.append(dict(row=i,task=r['task'],seed=r['seed'],timed_out=r['timed_out'],post_write=round(tend-tw,1),idle=round(tend-max([tw]+after),1),gap_max=round(gap,1)))
for o in out: print(json.dumps(o))
for T in (300,600,1200):
    c1=[o for o in out if o['idle']>=T]; c2=[o for o in out if o['timed_out']=='True' and o['gap_max']>=T]
    print(T,'c1',len(c1),'c2',len(c2),'ewi',len({(o['task'],o['seed']) for o in c1+c2}))
