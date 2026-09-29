const complaintTableBody = document.getElementById('complaintTableBody');
const totalComplaints = document.getElementById('totalComplaints');
const pendingCount = document.getElementById('pendingCount');
const highPriorityCount = document.getElementById('highPriorityCount');
const inProgressCount = document.getElementById('inProgressCount');
const resolvedCount = document.getElementById('resolvedCount');
const refreshBtn = document.getElementById('refreshBtn');
const complaintDialog = document.getElementById('complaintDialog');
const departmentNotifications = document.getElementById('departmentNotifications');
const detailMessage = document.getElementById('detailMessage');
const pageHost = String(window.location.hostname || '').trim();
const API_BASE_URL = window.location.port === '5000'
  ? ''
  : (!pageHost || ['localhost', '127.0.0.1', '[::1]'].includes(pageHost) ? 'http://localhost:5000' : '');

let currentComplaints = [];
let selectedComplaint = null;

const translate = (key) => window.SamadhanI18n.translate(key);
const translateDepartment = (department) => window.SamadhanI18n.translateDepartment(department);
const translatePriority = (priority) => window.SamadhanI18n.translatePriority(priority);
const translateStatus = (status) => window.SamadhanI18n.translateStatus(status);

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (character) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#039;',
  })[character]);
}

function formatStatus(status = 'Submitted') {
  return status.toLowerCase().replace(/\s+/g, '-') || 'submitted';
}

function formatDateTime(value) {
  const date = new Date(value);
  if (!value || Number.isNaN(date.getTime())) return '—';
  return new Intl.DateTimeFormat(window.SamadhanI18n.getLanguage(), {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(date);
}

function renderStats(complaints) {
  totalComplaints.textContent = complaints.length;
  pendingCount.textContent = complaints.filter((item) => item.status === 'Pending' || item.status === 'Submitted').length;
  highPriorityCount.textContent = complaints.filter((item) => item.priority === 'High').length;
  inProgressCount.textContent = complaints.filter((item) => item.status === 'In Progress').length;
  resolvedCount.textContent = complaints.filter((item) => item.status === 'Resolved').length;
}

function renderNotifications(complaints) {
  const latest = complaints
    .slice()
    .sort((a, b) => new Date(b.updatedAt || b.createdAt).getTime() - new Date(a.updatedAt || a.createdAt).getTime())
    .slice(0, 5);

  if (!latest.length) {
    departmentNotifications.innerHTML = `<p class="empty-state">${escapeHtml(translate('noDepartmentComplaints'))}</p>`;
    return;
  }
  departmentNotifications.innerHTML = latest.map((item) => `
    <article class="department-notification">
      <strong>${escapeHtml(item.title)}</strong>
      <span>${escapeHtml(translateStatus(item.status))}</span>
      <small>${escapeHtml(new Intl.DateTimeFormat(window.SamadhanI18n.getLanguage(), {
        dateStyle: 'medium',
        timeStyle: 'short',
      }).format(new Date(item.updatedAt || item.createdAt)))}</small>
    </article>
  `).join('');
}

function renderTable(complaints) {
  if (!complaints.length) {
    complaintTableBody.innerHTML = `<tr><td colspan="9" class="empty-state">${escapeHtml(translate('noDepartmentComplaints'))}</td></tr>`;
    renderNotifications(complaints);
    return;
  }

  complaintTableBody.innerHTML = complaints
    .slice()
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
    .map((item) => {
      const priorityClass = ['High', 'Medium', 'Low'].includes(item.priority) ? item.priority.toLowerCase() : 'medium';
      const statusClass = formatStatus(item.status);
      const safeStatus = ['Submitted', 'Pending', 'In Progress', 'Resolved'].includes(item.status) ? item.status : 'Submitted';

      return `
        <tr>
          <td>#${escapeHtml(item.id)}</td>
          <td>${escapeHtml(item.category || 'General Grievance')}</td>
          <td>
            <strong>${escapeHtml((item.title || 'Untitled complaint').slice(0, 60))}</strong>
            <div class="table-subtext">${escapeHtml(item.description || item.location || 'No description provided')}</div>
          </td>
          <td>${escapeHtml(translateDepartment(item.department || 'General'))}</td>
          <td><span class="priority ${priorityClass}">${escapeHtml(translatePriority(item.priority || 'Medium'))}</span></td>
          <td><span class="badge ${statusClass}">${escapeHtml(translateStatus(safeStatus))}</span></td>
          <td><time datetime="${escapeHtml(item.createdAt || '')}">${escapeHtml(formatDateTime(item.createdAt))}</time></td>
          <td>
            <select class="status-select" data-id="${escapeHtml(item.id)}" aria-label="${escapeHtml(translate('updateStatus'))}">
              ${['Submitted', 'Pending', 'In Progress', 'Resolved'].map((status) => `
                <option value="${status}" ${safeStatus === status ? 'selected' : ''}>${escapeHtml(translateStatus(status))}</option>
              `).join('')}
            </select>
          </td>
          <td><button type="button" class="details-button" data-id="${escapeHtml(item.id)}">${escapeHtml(translate('viewDetails'))}</button></td>
        </tr>`;
    }).join('');

  complaintTableBody.querySelectorAll('.status-select').forEach((select) => {
    select.addEventListener('change', async () => {
      try {
        const response = await fetch(`${API_BASE_URL}/api/complaints/${encodeURIComponent(select.dataset.id)}/status`, {
          method: 'PUT',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ status: select.value }),
        });
        if (response.status === 401) {
          window.location.replace(`${API_BASE_URL}/login.html?role=department`);
          return;
        }
        if (!response.ok) {
          const result = await response.json();
          throw new Error(result.message || 'Status update failed.');
        }
        await loadComplaints();
      } catch (error) {
        window.alert(error.message);
        await loadComplaints();
      }
    });
  });

  complaintTableBody.querySelectorAll('.details-button').forEach((button) => {
    button.addEventListener('click', () => {
      selectedComplaint = currentComplaints.find((item) => item.id === button.dataset.id);
      if (selectedComplaint) showComplaintDetails(selectedComplaint);
    });
  });
  renderNotifications(complaints);
}

function showComplaintDetails(complaint) {
  document.getElementById('detailTitle').textContent = complaint.title;
  document.getElementById('detailCitizen').textContent = complaint.name || complaint.email || '—';
  document.getElementById('detailLocation').textContent = complaint.location || '—';
  document.getElementById('detailPriority').textContent = translatePriority(complaint.priority || '—');
  document.getElementById('detailStatus').textContent = translateStatus(complaint.status);
  document.getElementById('detailDescription').textContent = complaint.description;
  document.getElementById('detailStatusSelect').value = complaint.status;
  document.getElementById('detailDepartmentSelect').value = complaint.department;
  const photo = document.getElementById('detailPhoto');
  photo.classList.toggle('hidden', !complaint.photo);
  photo.src = complaint.photo || '';
  photo.alt = complaint.title;
  detailMessage.textContent = '';
  complaintDialog.showModal();
}

async function saveComplaintChanges() {
  if (!selectedComplaint) return;
  const changes = [
    {
      endpoint: `${API_BASE_URL}/api/complaints/${encodeURIComponent(selectedComplaint.id)}/status`,
      body: { status: document.getElementById('detailStatusSelect').value },
    },
    {
      endpoint: `${API_BASE_URL}/api/complaints/${encodeURIComponent(selectedComplaint.id)}/department`,
      body: { department: document.getElementById('detailDepartmentSelect').value },
    },
  ];

  detailMessage.textContent = '';
  const saveButton = document.getElementById('saveComplaintButton');
  saveButton.disabled = true;
  try {
    for (const change of changes) {
      const response = await fetch(change.endpoint, {
        method: 'PUT',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(change.body),
      });
      if (response.status === 401) {
        window.location.replace(`${API_BASE_URL}/login.html?role=department`);
        return;
      }
      const result = await response.json();
      if (!response.ok) throw new Error(result.message || 'Unable to save complaint changes.');
    }
    complaintDialog.close();
    await loadComplaints();
  } catch (error) {
    detailMessage.textContent = error.message;
  } finally {
    saveButton.disabled = false;
  }
}

async function loadComplaints() {
  try {
    const [profileResponse, complaintResponse] = await Promise.all([
      fetch(`${API_BASE_URL}/api/auth/me`, { credentials: 'include' }),
      fetch(`${API_BASE_URL}/api/complaints`, { credentials: 'include' }),
    ]);
    if (profileResponse.status === 401 || complaintResponse.status === 401) {
      window.location.replace(`${API_BASE_URL}/login.html?role=department`);
      return;
    }
    if (!profileResponse.ok || !complaintResponse.ok) {
      throw new Error('Unable to load department dashboard.');
    }
    const [{ user }, data] = await Promise.all([profileResponse.json(), complaintResponse.json()]);
    if (user.role !== 'department') {
      window.location.replace(`${API_BASE_URL}/`);
      return;
    }
    currentComplaints = data.complaints || [];
    document.getElementById('departmentProfile').textContent = `${user.name} · ${translateDepartment(user.department)}`;
    renderStats(currentComplaints);
    renderTable(currentComplaints);
  } catch (error) {
    complaintTableBody.innerHTML = `<tr><td colspan="9" class="empty-state">${escapeHtml(translate('loadError'))}</td></tr>`;
  }
}

document.getElementById('logoutButton').addEventListener('click', async () => {
  try {
    await fetch(`${API_BASE_URL}/api/auth/logout`, { method: 'POST', credentials: 'include' });
  } catch (error) {
    window.alert(translate('serverUnavailable'));
  } finally {
    window.location.replace(`${API_BASE_URL}/`);
  }
});
document.getElementById('saveComplaintButton').addEventListener('click', saveComplaintChanges);
refreshBtn.addEventListener('click', loadComplaints);
document.addEventListener('samadhan:language-change', loadComplaints);
loadComplaints();
