# EWI-relay-v1 vs ewi_idle.py

| case | old idle | relay idle | relay verdict |
| --- | --- | --- | --- |
| early-write-idle | 700.0 | 700 | True |
| early-write-late-rewrite | 50.0 | 700 | True |
| write-delete-rewrite | 300.0 | 700 | True |
| long-generation | 50.0 | 50 | False |
| timeout-continuous | 100.0 | 100 | False |
| nan-ts | missing ts |  | EWI不可判 |
