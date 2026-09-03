# Third-party notices

trade-relay is MIT-licensed (see [LICENSE](LICENSE)). The published package also ships the following third-party software, reproduced here with the notices its license requires.

## Vela (`@luxalgo/vela`)

The dashboard's Tape panel is drawn by [Vela](https://github.com/LuxAlgo/Vela), LuxAlgo's open-source charting library, licensed under the Apache License, Version 2.0. Its browser bundle (`vela.global.min.js`) is copied into `dist/` at build time and served by the relay from its own origin, so the dashboard makes no request to any CDN. The attribution mark Vela renders on the chart is left enabled, as its NOTICE asks.

A copy of the Apache License, Version 2.0 is available at <https://www.apache.org/licenses/LICENSE-2.0>. Vela's NOTICE file, reproduced verbatim:

```
Vela
Copyright (c) 2026 LuxAlgo
https://luxalgo.com/vela

This product includes the Vela charting library, developed by LuxAlgo.

ATTRIBUTION REQUIREMENT

Any product, website, or application that displays charts rendered by this
software must show a visible attribution to the Vela project on every page or
screen where such a chart is displayed.

The library satisfies this requirement automatically: it renders an attribution
mark (the project logomark linking to the Vela project page) on the chart
itself, enabled by default. You may restyle or reposition this mark to fit your
design.

You may disable the built-in mark (renderer feature `attribution`) ONLY if you
display an equivalent visible attribution — the name "Vela" together with a
link to the project page above — elsewhere on the same page or screen, in a
place available to your users.

Removing, hiding, or obscuring the attribution without providing the
equivalent notice described above is not permitted.

This file constitutes the NOTICE file described in Section 4(d) of the Apache
License, Version 2.0: redistributions of this software, in source or binary
form, must include a readable copy of these attribution notices.
```
