# iran-r32-tracker

Live at **https://hlash99.github.io/iran-r32-tracker/** · linked from the
[hlash99 dashboard](https://hlash99.github.io/).

A real-time probability that **Iran** advances to the 2026 World Cup Round of 32
as one of the **8 best third-placed teams**.

Iran finished Group G in 3rd on **3 pts / 0 GD / 3 GF** (three draws). The top two
(Belgium, Egypt) are through, so Iran's fate is decided by the **best-third-place
race** — settled by the final group matches on **June 27**.

### Model
- Iran's record is fixed; 5 third-placed teams are already locked above it, so Iran
  can afford at most **2 more** groups to produce a third-place team better than
  3 pts / 0 GD / 3 GF.
- Each pending group independently yields such a team with an editable probability;
  the page combines them with a **Poisson-binomial** distribution and shows the
  chance Iran lands in the top 8.
- **Baseline** comes from expected outcomes of the deciders. During the matches you
  drag the sliders or flip a group to *finished ABOVE / BELOW* and the gauge updates
  live. Your tweaks persist in the browser.

Seed data is public group-stage standings as of June 26, 2026 — fully editable.
No build step; pure HTML/JS. Not affiliated with FIFA.
