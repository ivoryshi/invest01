const groupKeys = ['strategyType', 'frequency', 'benchmark', 'benchmarkBasis'];

export function fundComparisonGroupValue(group) {
  return JSON.stringify(Object.fromEntries(groupKeys.map(key => [key, group[key]])));
}

const choiceGenerations = new WeakMap();

export async function refreshSnapshotChoices(select, { baseSnapshotId, load, makeOption }) {
  const generation = (choiceGenerations.get(select) || 0) + 1;
  choiceGenerations.set(select, generation);
  const data = await load();
  if (choiceGenerations.get(select) !== generation) return;
  const preferred = select.value;
  const choices = [makeOption(baseSnapshotId, 'Current')];
  for (const item of data.items || []) {
    if (item.status !== 'frozen' || item.baseSnapshotId !== baseSnapshotId || typeof item.createdAt !== 'string' || typeof item.snapshotId !== 'string') continue;
    choices.push(makeOption(item.snapshotId, `${item.title || item.snapshotId} / ${item.createdAt.slice(0, 10)} / ${item.snapshotId.slice(-12)}`));
  }
  select.replaceChildren(...choices);
  if (preferred && !choices.some(item => item.value === preferred)) select.append(makeOption(preferred, `Unavailable: ${preferred}`));
  select.value = preferred || baseSnapshotId;
}

export function fundMetadataEditPayload(loaded, { title, notes }) {
  if (!loaded || !title?.trim()) throw new Error('saved_config_and_title_required');
  return { ...loaded, title: title.trim(), notes };
}

export function isCurrentFundEdit(sentId, sentGeneration, currentId, currentGeneration) {
  return sentId === currentId && sentGeneration === currentGeneration;
}
