"""EWI idle-after-write metrics for a run dir (read-only). usage: ewi_idle.py <run_dir>"""
import csv,json,os,re,sys,datetime as D
R=sys.argv[1]; done={}
for l in open(f'{R}/batch.log'):
    m=re.match(r'(\S+) run (\d+) done',l)
    if m: done[int(m.group(2))]=D.datetime.fromisoformat(m.group(1)).timestamp()
out=[]
for i,r in enumerate(csv.DictReader(open(f'{R}/summary.csv')),2):
    tr=r['trace']; od=os.path.join(os.path.dirname(tr),'outputs')
    tw=max(os.path.getmtime(os.path.join(a,f)) for a,_,b in os.walk(od) for f in b)
    am=[json.loads(x) for x in open(tr)]; am=[x['ts']/1000 for x in am if x.get('type')=='assistant_message']
    after=[t for t in am if t>tw]; tend=done[int(r['n'])]
    pts=[tw]+after+[tend]; gap=max(b-a for a,b in zip(pts,pts[1:]))
    out.append(dict(row=i,task=r['task'],seed=r['seed'],timed_out=r['timed_out'],post_write=round(tend-tw,1),idle=round(tend-max([tw]+after),1),gap_max=round(gap,1)))
for o in out: print(json.dumps(o))
for T in (300,600,1200):
    c1=[o for o in out if o['idle']>=T]; c2=[o for o in out if o['timed_out']=='True' and o['gap_max']>=T]
    print(T,'c1',len(c1),'c2',len(c2),'ewi',len({(o['task'],o['seed']) for o in c1+c2}))
