// Entry selection is optional and allowlisted. All inherited views remain available.
const params = new URLSearchParams(window.location.search);
const entry = params.get('view') || 'home';
if (NAV.some(([id]) => id === entry)) state.page = entry;
if (CFG.narratives.some(n => n.id === params.get('narrative'))) { state.page='narratives';state.narrative=params.get('narrative'); }
