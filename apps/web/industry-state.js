export function nextIndustryConfigId(items) {
  const used = new Set(items.map(item => item.configId));
  const base = 'config.industry_parquet_manual';
  let id = base;
  let i = 2;
  while (used.has(id)) id = `${base}_${i++}`;
  return id;
}

export function latestIndustryConfig(items, configId) {
  return items.find(item => item.configId === configId && item.strategyTemplateId === 'strategy.industry_parquet_monthly_topn') || null;
}

export function industrySaveMethod(editingId, configId) {
  return editingId === configId ? 'PUT' : 'POST';
}
