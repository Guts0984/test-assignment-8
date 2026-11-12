# Intentionally empty

Next.js would treat `src/pages` (the Feature-Sliced Design "pages" layer) as its Pages Router.
Having this root-level `pages/` folder makes Next ignore `src/pages`. The real routes live in `app/`.
