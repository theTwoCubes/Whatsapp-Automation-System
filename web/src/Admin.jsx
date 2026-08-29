import React from 'react';
import Dashboard  from './views/admin/Dashboard.jsx';
import Knowledge  from './views/admin/Knowledge.jsx';
import Followups  from './views/admin/Followups.jsx';
import Setup      from './views/admin/Setup.jsx';
import TeamAccess from './views/admin/TeamAccess.jsx';

const views = {
  dashboard: Dashboard,
  knowledge:  Knowledge,
  followups:  Followups,
  setup:      Setup,
  team:       TeamAccess,
};

export default function Admin({ activeTab }) {
  const View = views[activeTab] || Dashboard;
  return (
    <div className="flex flex-1 min-h-0 overflow-hidden">
      <div className="flex-1 overflow-y-auto bg-surface-page">
        <View />
      </div>
    </div>
  );
}
