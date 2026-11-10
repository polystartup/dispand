import "react-grid-layout/css/styles.css";
import { BREAKPOINTS, GRID } from "@dispand/domain/pages/layout";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { type Layout, type ResponsiveLayouts, Responsive, useContainerWidth } from "react-grid-layout";
import { orpc } from "../../lib/api.ts";
import { GridWidget } from "../widgets/GridWidget.tsx";
import { TableWidget } from "../widgets/TableWidget.tsx";
import { TriggerWidget } from "../widgets/TriggerWidget.tsx";
import { type Widget, WorkflowFormWidget } from "../widgets/WorkflowFormWidget.tsx";

type Props = { pageId: string; widgets: Widget[]; editing: boolean };

const same = (a: Layout, b: Layout | undefined) =>
  a.every((item) => {
    const pos = b?.find((x) => x.i === item.i);
    return pos && pos.x === item.x && pos.y === item.y && pos.w === item.w && pos.h === item.h;
  });

/** The page's widgets on a responsive grid; in edit mode they move and resize, and each breakpoint's layout is saved. */
export function Dashboard({ pageId, widgets, editing }: Props) {
  const { width, containerRef, mounted } = useContainerWidth();
  const queryClient = useQueryClient();
  const saveKey = orpc.widgets.saveLayout.mutationKey();
  const save = useMutation(
    orpc.widgets.saveLayout.mutationOptions({
      // One save at a time, in order: a later layout is never overwritten by an earlier one.
      scope: { id: `saveLayout:${pageId}` },
      // A save that failed: the positions go back to the saved ones (the refetch below), and the
      // owner is told, instead of keeping an arrangement that would vanish on reload.
      onError: () => setMoved({}),
      // Refetch once the last queued save is done (this one still counts as running here).
      onSettled: () => {
        if (queryClient.isMutating({ mutationKey: saveKey }) <= 1) void queryClient.invalidateQueries({ queryKey: orpc.pages.key() });
      },
    }),
  );
  // Positions the owner set in this visit win over what the server last sent: a refetch can't snap a widget back.
  const [moved, setMoved] = useState<ResponsiveLayouts>({});
  const layouts = useMemo<ResponsiveLayouts>(
    () =>
      Object.fromEntries(
        BREAKPOINTS.map((bp) => [
          bp,
          widgets.map((w) => {
            const pos = moved[bp]?.find((item) => item.i === w.id) ?? w.layout[bp];
            return { i: w.id, x: pos.x, y: pos.y, w: pos.w, h: pos.h, minW: 1, minH: 3 };
          }),
        ]),
      ),
    [widgets, moved],
  );

  return (
    <div ref={containerRef} className="-mx-2.5">
      {save.isError && (
        <p role="alert" className="mx-2.5 mb-3 text-[14px] text-danger">
          Could not save the layout: the widgets are back where they were saved. Move them again to retry.
        </p>
      )}
      {mounted && (
        <Responsive
          width={width}
          layouts={layouts}
          breakpoints={GRID.breakpoints}
          cols={GRID.cols}
          rowHeight={44}
          margin={[20, 20]}
          containerPadding={[10, 0]}
          dragConfig={{ enabled: editing, handle: ".widget-drag", cancel: "input,button,textarea" }}
          resizeConfig={{ enabled: editing, handles: ["se"] }}
          className={editing ? "dashboard-editing" : undefined}
          onLayoutChange={(_, all) => {
            if (!editing) return;
            const changed = Object.fromEntries(
              BREAKPOINTS.flatMap((bp) => {
                const items = all[bp];
                return items && !same(items, layouts[bp]) ? [[bp, items.map(({ i, x, y, w, h }) => ({ i, x, y, w, h }))]] : [];
              }),
            );
            if (Object.keys(changed).length === 0) return;
            setMoved((m) => ({ ...m, ...changed }));
            save.mutate({ pageId, layouts: changed });
          }}
        >
          {widgets.map((w) => (
            <div key={w.id}>
              {w.type === "grid" ? <GridWidget widget={w} editing={editing} /> : w.type === "table" ? <TableWidget widget={w} editing={editing} /> : w.type === "trigger-form" ? <TriggerWidget widget={w} editing={editing} /> : <WorkflowFormWidget widget={w} editing={editing} />}
            </div>
          ))}
        </Responsive>
      )}
    </div>
  );
}
