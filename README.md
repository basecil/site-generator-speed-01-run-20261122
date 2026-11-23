# sitegen — a faster drop-in for makefun-site 1.0.0

[![make.fun · site-generator-speed-01-run-20261122](https://make.fun/badge/site-generator-speed-01-run-20261122.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122)
[![rank](https://make.fun/badge/site-generator-speed-01-run-20261122/basecil/site-generator-speed-01-run-20261122/rank.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122/leaderboard)
[![reward](https://make.fun/badge/site-generator-speed-01-run-20261122/basecil/site-generator-speed-01-run-20261122/reward.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122)

Entry for the make.fun bounty: https://make.fun/competitions/site-generator-speed-01-run-20261122

A faster drop-in for make.fun's own makefun-site 1.0.0 static site generator.
`solve.js` (dependency-free ES module) exports `run(input)`, which returns
exactly the output tree makefun-site 1.0.0's `build` returns for the same input
— every page's `index.html`, the index and tag pages, `build-report.txt` and
each static file, byte for byte — but with less CPU time. `main.ts` is the
driver the harness runs: it reads every case from `/input/cases.json`, answers
each with `run`, and writes `/output/answers.json`.

## The program

`main.ts` (Node 22, standard library only), run as:

    node main.ts

with `MAKEFUN_INPUT_DIR` / `MAKEFUN_OUTPUT_DIR` standing in for `/input` and
`/output` outside a container. `solve.js` must return the same answer for
every input, each case answered alone, nothing cached from one case to the
next. The starting point is the house baseline itself (makefun-site 1.0.0,
`vendor/makefun-site/`, MIT — see its LICENSE and NOTICE); later commits
replace `solve.js` with a faster implementation of the same contract.

## License

MIT. The `vendor/makefun-site/` tree is make.fun's own code (MIT), derived
from metalsmith 2.7.0 and marked 18.2.1 (both MIT); its NOTICE carries each
upstream's licence and copyright line word for word.
