import React from "react";
import { afterEach, expect, test } from "bun:test";
import { cleanup, render } from "ink-testing-library";
import { MemoryRouter } from "react-router";
import { waitForText } from "../testing";
import { ConfirmAction, type ActionTrigger } from "./ConfirmAction";

afterEach(cleanup);

test("resolves the trigger after loading and does not skip a late confirmation", async () => {
  let calls = 0;
  const action = async () => {
    calls += 1;
    return { rows: {} };
  };
  const view = (isPending: boolean, trigger: ActionTrigger) => (
    <MemoryRouter>
      <ConfirmAction
        breadcrumb={["agentcore", "test"]}
        trigger={trigger}
        isPending={isPending}
        error={null}
        action={action}
        successTitle="Done"
        runningLabel="running…"
        onDone={() => {}}
      />
    </MemoryRouter>
  );

  const screen = render(view(true, { kind: "immediate" }));
  screen.rerender(view(false, { kind: "confirm", message: "Delete everything?" }));

  await waitForText(screen.lastFrame, "Delete everything?");
  expect(calls).toBe(0);
});
