// ==========================================
// VISIT RECORDS: COMPACT PAGINATED VIEW
// ==========================================
// Loaded after app.js so the existing visit loader and data model remain unchanged.
// Historical records are retained; pagination only limits how many rows are shown.

window.changeVisitLogPage = function(nextPage) {
    window.visitLogCurrentPage = Number(nextPage) || 1;
    if (typeof window.renderVisitLog === 'function') window.renderVisitLog();
};

window.renderVisitLog = function() {
    const records = window.visitLogRecords || [];
    const search = (document.getElementById('visitLogSearch')?.value || '').trim().toLowerCase();
    const role = document.getElementById('visitLogRole')?.value || '';
    const date = document.getElementById('visitLogDate')?.value || '';
    const filterSignature = JSON.stringify([search, role, date]);

    if (window.visitLogFilterSignature !== filterSignature) {
        window.visitLogFilterSignature = filterSignature;
        window.visitLogCurrentPage = 1;
    }

    const filtered = records.filter(record => {
        const recordRole = record.role || '';
        const roleMatches = !role ||
            (role === 'Parent' ? recordRole === 'Parent' : recordRole === role);
        const haystack = [record.user, record.role, record.action_type, record.details].join(' ').toLowerCase();
        const searchMatches = !search || haystack.includes(search);
        const dateMatches = !date || String(record.created_at || '').startsWith(date);
        return roleMatches && searchMatches && dateMatches;
    });

    // Summary cards continue to reflect all loaded records, not only the visible page.
    const visitRecords = records.filter(record =>
        record.action_type === 'System Visit' || record.action_type === 'Parent Login'
    );
    const parentVisits = document.getElementById('visitLogParentVisits');
    const adminVisits = document.getElementById('visitLogAdminVisits');
    const pageViews = document.getElementById('visitLogPageViews');
    if (parentVisits) parentVisits.textContent =
        visitRecords.filter(record => record.role === 'Parent').length;
    if (adminVisits) adminVisits.textContent =
        visitRecords.filter(record => record.role && record.role !== 'Parent').length;
    if (pageViews) pageViews.textContent =
        records.filter(record => record.action_type === 'Page View' || record.action_type === 'Parent Page View').length;

    const tbody = document.getElementById('visitLogTableBody');
    if (!tbody) return;

    const pageSize = 10;
    const totalPages = Math.max(1, Math.ceil(filtered.length / pageSize));
    window.visitLogCurrentPage = Math.min(
        Math.max(1, Number(window.visitLogCurrentPage) || 1),
        totalPages
    );

    if (!filtered.length) {
        tbody.innerHTML = '<tr><td colspan="5" style="padding:20px;text-align:center;color:#64748b;">No visit records found.</td></tr>';
    } else {
        const firstIndex = (window.visitLogCurrentPage - 1) * pageSize;
        const visibleRecords = filtered.slice(firstIndex, firstIndex + pageSize);
        const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, char => ({
            '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
        })[char]);

        tbody.innerHTML = visibleRecords.map(record => {
            const dateText = record.created_at
                ? new Date(record.created_at).toLocaleString()
                : 'Unknown';
            const details = String(record.details || '');
            return '<tr>' +
                '<td style="padding:10px;border-bottom:1px solid #e2e8f0;white-space:nowrap;">' + escapeHtml(dateText) + '</td>' +
                '<td style="padding:10px;border-bottom:1px solid #e2e8f0;font-weight:bold;">' + escapeHtml(record.user) + '</td>' +
                '<td style="padding:10px;border-bottom:1px solid #e2e8f0;white-space:nowrap;">' + escapeHtml(record.role) + '</td>' +
                '<td style="padding:10px;border-bottom:1px solid #e2e8f0;">' + escapeHtml(record.action_type) + '</td>' +
                '<td class="visit-log-details-cell" title="' + escapeHtml(details) + '" style="padding:10px;border-bottom:1px solid #e2e8f0;">' + escapeHtml(details) + '</td>' +
                '</tr>';
        }).join('');
    }

    const pagination = document.getElementById('visitLogPagination');
    if (pagination) {
        const firstVisible = filtered.length ? ((window.visitLogCurrentPage - 1) * pageSize) + 1 : 0;
        const lastVisible = Math.min(window.visitLogCurrentPage * pageSize, filtered.length);
        pagination.innerHTML =
            '<div class="visit-log-pagination-summary">Showing ' + firstVisible + '-' + lastVisible +
            ' of ' + filtered.length + ' matching records</div>' +
            '<div class="visit-log-pagination-controls">' +
            '<button type="button" class="btn-standard" onclick="window.changeVisitLogPage(' + (window.visitLogCurrentPage - 1) + ')" ' +
            (window.visitLogCurrentPage <= 1 ? 'disabled' : '') + '>Previous</button>' +
            '<span>Page ' + window.visitLogCurrentPage + ' of ' + totalPages + '</span>' +
            '<button type="button" class="btn-standard" onclick="window.changeVisitLogPage(' + (window.visitLogCurrentPage + 1) + ')" ' +
            (window.visitLogCurrentPage >= totalPages ? 'disabled' : '') + '>Next</button>' +
            '</div>';
    }
};
