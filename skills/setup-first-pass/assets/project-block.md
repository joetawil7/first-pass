<!-- first-pass:project:start (written once by the setup-first-pass skill; yours to edit, re-runs keep it) -->

### This repo (first-pass)

- **What it is:** {{what}}
- **CI's checks** (what must pass before a merge): {{ci_checks}}
- **Run one test file:** {{one_test}}
- **Real tests** (the layer that catches what mocks miss): {{real_tests}}
- **What they need running, and how to start and stop it:** {{services}}
- **Looking at the UI running** (how a screen this repo changes is opened and seen): {{ui_check}}
- **Test limits** (what never to run here, and how much at once): {{test_limits}}
- **Heavy runs** (what they are here and their limits; how this machine runs them is the machine block's): {{heavy_runs}}
- **Local runs that reach real people** (what a local server, worker or test run sends for real, and the empty keys or switches that stop it): {{outward}}
- **Monitoring** (where a swallowed error must end up): {{monitoring}}
- **Words live in:** {{words}}
- **The same job in two places** (a change to one needs the other): {{twin_paths}}
- **Extra pre-mortem cases** (this repo's own ways to run twice, end, or scale): {{extra_cases}}
- **Owner rules:** {{owner_rules}}
- **Invariants:** `INVARIANTS.md`

<!-- first-pass:project:end -->
