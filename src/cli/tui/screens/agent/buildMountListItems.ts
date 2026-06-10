/** Build the add/edit/remove/done item list for a filesystem mount review screen. */
export function buildMountListItems(
  mounts: { accessPointArn: string; mountPath: string }[],
  label: string,
  max: number
) {
  return [
    ...mounts.flatMap((m, i) => [
      {
        id: `edit:${i}`,
        title: `Edit ${label} mount ${i + 1}: ${m.mountPath}`,
        description: m.accessPointArn.slice(-30),
      },
      { id: `remove:${i}`, title: `Remove ${label} mount ${i + 1}: ${m.mountPath}` },
    ]),
    ...(mounts.length < max ? [{ id: 'add', title: `Add another ${label} mount`, spaceBefore: true }] : []),
    { id: 'done', title: 'Continue', spaceBefore: mounts.length >= max },
  ];
}
