// Testing Library's findBy*/waitFor give up after 1 s: too short when several test files share
// a busy CPU (CI, a machine running other suites). A wait ends as soon as its condition holds, so
// the ceiling only matters for a test that fails.
import { configure } from "@testing-library/react";

configure({ asyncUtilTimeout: 5_000 });
