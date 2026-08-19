const accountsBody = document.querySelector('#accounts');
const toast = document.querySelector('#toast');
const accountsStorageKey = 'mail-code-accounts';
const routesStorageKey = 'mail-code-routes';
let savedAccounts = readSavedAccounts();
const proxyPoolInput = document.querySelector('#proxy-pool-input');
const proxyPoolStatus = document.querySelector('#proxy-pool-status');
const splitProgress = document.querySelector('#split-progress');
let healthPollingTimer = null;
let healthPollingInFlight = false;

function notify(message, error = false) {
  toast.textContent = message;
  toast.style.background = error ? '#a9433d' : '#10212b';
  toast.classList.add('show');
  setTimeout(() => toast.classList.remove('show'), 2800);
}

async function request(path, options = {}) {
  const headers = new Headers(options.headers || {});
  const response = await fetch(path, {...options, headers});
  const type = response.headers.get('content-type') || '';
  const body = type.includes('json') ? await response.json() : await response.text();
  if (!response.ok) throw new Error(body?.detail || body?.error || `HTTP ${response.status}`);
  return body;
}

function readSavedAccounts() {
  try {
    const value = JSON.parse(localStorage.getItem(accountsStorageKey) || '[]');
    if (Array.isArray(value)) return value.map(normalizeAccount).filter(account => account.email);
  } catch {}
  return [];
}

function normalizeAccount(account) {
  return {
    email: String(account?.email || '').toLowerCase(),
    password: String(account?.password || ''),
    status: String(account?.status || '已保存'),
    addresses: Array.isArray(account?.addresses) ? account.addresses.map(route => ({
      address: String(route?.address || ''),
      url: String(route?.url || ''),
    })).filter(route => route.address && route.url) : [],
  };
}

function flattenLines(accounts) {
  return accounts.flatMap(account => account.addresses.map(route => `${route.address}----${route.url}`));
}

function saveAccounts(accounts) {
  savedAccounts = accounts.map(normalizeAccount);
  localStorage.setItem(accountsStorageKey, JSON.stringify(savedAccounts));
  localStorage.setItem(routesStorageKey, JSON.stringify(flattenLines(savedAccounts)));
}

function parseCredentialLines(text) {
  return text.split(/\r?\n/).map(line => line.trim()).filter(line => line && !line.startsWith('#')).map(line => {
    const delimiter = ['----', '---', '\t', ','].find(value => line.includes(value));
    if (!delimiter) return null;
    const index = line.indexOf(delimiter);
    return {email: line.slice(0, index).trim().toLowerCase(), password: line.slice(index + delimiter.length).trim()};
  }).filter(row => row && row.email && row.password);
}

function lineToRoute(line) {
  const index = line.indexOf('----');
  if (index < 1) return null;
  return {address: line.slice(0, index), url: line.slice(index + 4)};
}

function mergeAccounts(existing, fresh) {
  const map = new Map(existing.map(normalizeAccount).map(account => [account.email, account]));
  fresh.map(normalizeAccount).forEach(account => {
    const current = map.get(account.email) || {email: account.email, password: '', status: '已保存', addresses: []};
    current.password = account.password || current.password;
    current.status = account.status || current.status;
    const routeMap = new Map(current.addresses.map(route => [route.address.toLowerCase(), route]));
    account.addresses.forEach(route => routeMap.set(route.address.toLowerCase(), route));
    current.addresses = [...routeMap.values()];
    map.set(account.email, current);
  });
  return [...map.values()];
}

function statusClass(value) {
  return value === '已验证' || value.startsWith('分裂成功') ? 'ready' : value.startsWith('分裂失败') ? 'bad' : '';
}

function splitProgressClass(job) {
  if (job.status === '成功') return 'ready';
  if (job.status === '失败') return 'bad';
  if (job.status === '运行中') return 'pending';
  return '';
}

function renderSplitProgress(jobs = []) {
  if (!splitProgress) return;
  if (!jobs.length) {
    splitProgress.hidden = true;
    splitProgress.innerHTML = '';
    return;
  }
  const done = jobs.filter(job => job.status === '成功' || job.status === '失败').length;
  const success = jobs.filter(job => job.status === '成功').length;
  const failed = jobs.filter(job => job.status === '失败').length;
  const created = jobs.reduce((sum, job) => sum + (job.created || 0), 0);
  splitProgress.hidden = false;
  splitProgress.innerHTML = `
    <div class="split-progress-head">
      <strong>分裂进度 ${done}/${jobs.length}</strong>
      <span class="muted">成功账号 ${success} 个，失败账号 ${failed} 个，已生成 ${created} 个地址</span>
    </div>
    <div class="split-progress-list">
      ${jobs.map((job, index) => `
        <div class="split-progress-row">
          <span class="split-progress-index">${index + 1}</span>
          <span class="split-progress-email">${escapeHtml(job.email)}</span>
          <span class="status ${splitProgressClass(job)}">${escapeHtml(job.status)}</span>
          <span class="split-progress-detail">${
            job.status === '成功'
              ? `生成 ${job.created || 0} 个`
              : job.error
                ? escapeHtml(job.error)
                : ''
          }</span>
        </div>
      `).join('')}
    </div>`;
}

function renderAccounts(accounts) {
  const rows = accounts.flatMap(account => account.addresses.length ? account.addresses.map(route => ({account, route})) : [{account, route: null}]);
  document.querySelector('#account-count').textContent = accounts.length;
  document.querySelector('#route-count').textContent = rows.filter(row => row.route).length;
  if (!rows.length) {
    accountsBody.innerHTML = '<tr><td colspan="5" class="empty">导入账号后显示地址</td></tr>';
    document.querySelector('#table-status').textContent = '暂无已保存账号';
    return;
  }
  accountsBody.innerHTML = rows.map(({account, route}) => `
    <tr>
      <td>${escapeHtml(account.email)}</td>
      <td>${escapeHtml(account.password || '—')}</td>
      <td><span class="status ${statusClass(account.status)}">${escapeHtml(account.status)}</span></td>
      <td>${route ? `<span class="route" title="${escapeHtml(route.url)}">${escapeHtml(route.url)}</span>` : '—'}</td>
      <td>${route ? `<button class="copy" data-url="${escapeHtml(route.url)}">复制</button>` : '—'}</td>
    </tr>`).join('');
  accountsBody.querySelectorAll('.copy').forEach(button => button.addEventListener('click', async () => {
    await navigator.clipboard.writeText(button.dataset.url);
    notify('接码 URL 已复制');
  }));
  document.querySelector('#table-status').textContent = '结果已保存在当前浏览器';
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>'"]/g, character => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[character]));
}

function routeForEmail(email) {
  for (const account of savedAccounts) {
    const route = account.addresses.find(item => item.address.toLowerCase() === email.toLowerCase());
    if (route) return route;
  }
  return null;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function routeAddresses(lines) {
  return new Set(lines.map(lineToRoute).filter(Boolean).map(route => route.address.toLowerCase()));
}

async function fetchAccountRoutes(account) {
  const result = await request('/auth/login', {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({email: account.email, password: account.password}),
  });
  return (result.routes || []).map(route => ({
    address: String(route.address || '').toLowerCase(),
    url: String(route.url || ''),
  })).filter(route => route.address && route.url);
}

async function recoverRoutesAfterUncertainSplit(account, outputLines, attempts = 6) {
  const knownAccountRoutes = new Set(account.addresses.map(route => route.address.toLowerCase()));
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    if (attempt > 1) await sleep(5000);
    const routes = await fetchAccountRoutes(account);
    const outputAddresses = routeAddresses(outputLines);
    const recoveredRoutes = [];
    for (const route of routes) {
      if (!knownAccountRoutes.has(route.address)) {
        account.addresses.push(route);
        knownAccountRoutes.add(route.address);
      }
      if (!outputAddresses.has(route.address)) {
        outputLines.push(`${route.address}----${route.url}`);
        outputAddresses.add(route.address);
        recoveredRoutes.push(route);
      }
    }
    if (recoveredRoutes.length) return recoveredRoutes;
  }
  return [];
}

async function checkHealth() {
  try {
    const result = await request('/health');
    const badge = document.querySelector('#health-badge');
    badge.textContent = result.ok ? '服务正常' : '服务异常';
    badge.className = `badge ${result.ok ? 'ok' : 'bad'}`;
    if (proxyPoolStatus) {
      const stats = result.proxy_pool || {};
      proxyPoolStatus.textContent = stats.enabled
        ? `当前 ${stats.total || 0} 条，已分配 ${stats.assigned || 0} 条，剩余 ${stats.remaining || 0} 条`
        : '未配置代理池';
    }
  } catch {
    const badge = document.querySelector('#health-badge');
    badge.textContent = '无法连接';
    badge.className = 'badge bad';
    if (proxyPoolStatus) proxyPoolStatus.textContent = '无法读取状态';
  }
}

async function pollHealthOnce() {
  if (healthPollingInFlight) return;
  healthPollingInFlight = true;
  try {
    await checkHealth();
  } finally {
    healthPollingInFlight = false;
  }
}

function startHealthPolling() {
  if (healthPollingTimer) return;
  if (proxyPoolStatus) proxyPoolStatus.classList.add('live');
  pollHealthOnce();
  healthPollingTimer = setInterval(pollHealthOnce, 2000);
}

function stopHealthPolling() {
  if (!healthPollingTimer) return;
  clearInterval(healthPollingTimer);
  healthPollingTimer = null;
  if (proxyPoolStatus) proxyPoolStatus.classList.remove('live');
}

document.querySelector('#refresh').addEventListener('click', () => {
  savedAccounts = readSavedAccounts();
  renderAccounts(savedAccounts);
  notify('已刷新浏览器保存结果');
});

document.querySelector('#import').addEventListener('click', async () => {
  const credentials = document.querySelector('#credentials').value.trim();
  if (!credentials) return notify('请先输入邮箱账号', true);
  const credentialRows = parseCredentialLines(credentials);
  const verify = document.querySelector('#verify').checked;
  const useProxy = document.querySelector('#use-proxy').checked;
  const splitCount = Number(document.querySelector('#import-split-count').value || 0);
  const splitDomain = document.querySelector('#import-split-domain').value.trim();
  const randomDomainTlds = [
    document.querySelector('#random-com-domain').checked ? 'com' : '',
    document.querySelector('#random-net-domain').checked ? 'net' : '',
  ].filter(Boolean);
  const status = document.querySelector('#import-status');
  status.textContent = '保存并验证中...';
  renderSplitProgress([]);
  startHealthPolling();
  try {
    const result = await request(`/admin/import?verify=${verify}&use_proxy=${useProxy}`, {method:'POST', headers:{'Content-Type':'text/plain; charset=utf-8'}, body:credentials});
    const resultByEmail = new Map((result.results || []).map(item => [item.email, item]));
    const freshAccounts = credentialRows.map(row => ({
      email: row.email,
      password: row.password,
      status: resultByEmail.get(row.email)?.verification?.ok ? '已验证' : '已保存',
      addresses: [],
    }));
    (result.lines || []).map(lineToRoute).filter(Boolean).forEach(route => {
      const account = freshAccounts.find(item => item.email === route.address.toLowerCase());
      if (account) account.addresses.push(route);
    });
    let outputLines = result.lines || [];
    const splitErrors = [];
    if (splitCount > 0) {
      status.textContent = `已导入，正在批量分裂 ${freshAccounts.length} 个账号...`;
      const splitJobs = freshAccounts.map(account => ({
        email: account.email,
        status: '等待中',
        created: 0,
        error: '',
      }));
      renderSplitProgress(splitJobs);
      for (const [index, account] of freshAccounts.entries()) {
        const job = splitJobs[index];
        const splitCreatedSoFar = outputLines.length - (result.lines || []).length;
        job.status = '运行中';
        account.status = `正在分裂 ${index + 1}/${freshAccounts.length}`;
        status.textContent = `正在分裂 ${index + 1}/${freshAccounts.length}：${account.email}，已生成 ${splitCreatedSoFar} 个，失败 ${splitErrors.length} 个`;
        renderSplitProgress(splitJobs);
        renderAccounts(mergeAccounts(savedAccounts, freshAccounts));
        try {
          const split = await request('/aliases/split', {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({
              email: account.email,
              password: account.password,
              count: splitCount,
              ...(splitDomain ? {domain: splitDomain} : {}),
              ...(randomDomainTlds.length ? {random_domain_tlds: randomDomainTlds} : {}),
            }),
          });
          const splitRoutes = (split.routes || []).map(route => ({address: route.address, url: route.url}));
          account.addresses.push(...splitRoutes);
          account.status = `分裂成功 ${splitRoutes.length} 个`;
          job.status = '成功';
          job.created = splitRoutes.length;
          outputLines = outputLines.concat(splitRoutes.map(route => `${route.address}----${route.url}`));
        } catch (error) {
          const uncertain = /HTTP 504|上限|alias_limit|timeout|timed out/i.test(error.message);
          if (uncertain) {
            job.status = '运行中';
            job.error = '请求超时，正在回捞已生成地址...';
            account.status = '请求超时，正在回捞';
            status.textContent = `${account.email} 请求超时，正在回捞已生成地址...`;
            renderSplitProgress(splitJobs);
            try {
              const recoveredRoutes = await recoverRoutesAfterUncertainSplit(account, outputLines);
              if (recoveredRoutes.length) {
                account.status = `分裂成功 ${recoveredRoutes.length} 个（超时后回捞）`;
                job.status = '成功';
                job.created = recoveredRoutes.length;
                job.error = '';
              } else {
                account.status = `分裂失败: ${error.message}`;
                job.status = '失败';
                job.error = `${error.message}；回捞未发现新地址`;
                splitErrors.push(`${account.email}: ${job.error}`);
              }
            } catch (recoverError) {
              account.status = `分裂失败: ${error.message}`;
              job.status = '失败';
              job.error = `${error.message}；回捞失败：${recoverError.message}`;
              splitErrors.push(`${account.email}: ${job.error}`);
            }
          } else {
            account.status = `分裂失败: ${error.message}`;
            job.status = '失败';
            job.error = error.message;
            splitErrors.push(`${account.email}: ${error.message}`);
          }
        }
        const processed = index + 1;
        const splitCreatedNow = outputLines.length - (result.lines || []).length;
        status.textContent = `分裂进度 ${processed}/${freshAccounts.length}，已生成 ${splitCreatedNow} 个，失败 ${splitErrors.length} 个`;
        renderSplitProgress(splitJobs);
        renderAccounts(mergeAccounts(savedAccounts, freshAccounts));
      }
    }
    saveAccounts(mergeAccounts(savedAccounts, freshAccounts));
    document.querySelector('#import-result').value = outputLines.join('\n');
    document.querySelector('#import-result-block').hidden = false;
    renderAccounts(savedAccounts);
    const splitCreated = outputLines.length - (result.lines || []).length;
    const failureSummary = splitErrors.length ? `，失败 ${splitErrors.length} 个账号：${splitErrors.join('；')}` : '';
    status.textContent = `已保存 ${result.imported} 个账号${splitCount ? `，分裂完成 ${splitCreated} 个${failureSummary}` : ''}`;
    notify(splitErrors.length ? `导入完成，有 ${splitErrors.length} 个账号分裂失败` : `导入完成：${result.imported} 个账号`);
  } catch (error) {
    status.textContent = error.message;
    notify(error.message, true);
  } finally {
    stopHealthPolling();
    await checkHealth();
  }
});

document.querySelector('#copy-result').addEventListener('click', async () => {
  await navigator.clipboard.writeText(document.querySelector('#import-result').value);
  notify('邮箱----接码API 已复制');
});

document.querySelector('#save-proxy-pool').addEventListener('click', async () => {
  const proxyText = (proxyPoolInput?.value || '').trim();
  if (!proxyText) return notify('请先输入代理池内容', true);
  try {
    const result = await request('/proxy-pool', {
      method: 'POST',
      headers: {'Content-Type': 'text/plain; charset=utf-8'},
      body: proxyText,
    });
    if (proxyPoolStatus) {
      const stats = result.proxy_pool || {};
      proxyPoolStatus.textContent = `已保存 ${result.added || 0} 条，当前 ${stats.total || 0} 条`;
    }
    proxyPoolInput.value = '';
    notify(`代理池已保存 ${result.added || 0} 条`);
    checkHealth();
  } catch (error) {
    notify(error.message, true);
  }
});

document.querySelector('#clear-routes').addEventListener('click', () => {
  if (!savedAccounts.length) return notify('当前没有可清空的接码地址', true);
  if (!confirm(`确定清空 ${savedAccounts.length} 个账号和所有接码地址吗？此操作只会清除当前浏览器保存的数据。`)) return;
  savedAccounts = [];
  localStorage.removeItem(accountsStorageKey);
  localStorage.removeItem(routesStorageKey);
  document.querySelector('#import-result').value = '';
  document.querySelector('#import-result-block').hidden = true;
  renderAccounts([]);
  notify('已清空接码地址');
});

document.querySelector('#query').addEventListener('click', async () => {
  const input = document.querySelector('#query-emails').value.trim();
  const status = document.querySelector('#query-status');
  if (!input) return notify('请先输入邮箱', true);
  const emails = input.split(/[\n,]+/).map(value => value.trim().toLowerCase()).filter(Boolean);
  const maxAge = Number(document.querySelector('#max-age').value || 600);
  status.textContent = '查询中...';
  try {
    const results = await Promise.all(emails.map(async email => {
      const route = routeForEmail(email);
      if (!route) return {email, code: null, error: 'unknown_mailbox'};
      try {
        const response = await fetch(`${route.url}?max_age=${encodeURIComponent(maxAge)}`);
        const body = await response.json();
        return response.ok ? body : {...body, email};
      } catch {
        return {email, code: null, error: 'network_error'};
      }
    }));
    document.querySelector('#query-results').innerHTML = results.map(item => `
      <tr><td>${escapeHtml(item.email)}</td><td class="code-value">${escapeHtml(item.code || '—')}</td>
      <td>${escapeHtml(item.mail?.subject || '')}</td><td class="${item.error ? 'query-error' : 'query-ok'}">${escapeHtml(item.error || (item.code ? '已识别' : '暂无新码'))}</td></tr>`).join('');
    status.textContent = `完成 ${results.length} 个邮箱`;
  } catch (error) { status.textContent = error.message; notify(error.message, true); }
});

document.querySelector('#export').addEventListener('click', async () => {
  try {
    const lines = flattenLines(savedAccounts);
    if (!lines.length) throw new Error('当前没有已保存地址');
    const blob = new Blob([lines.join('\n') + '\n'], {type: 'text/plain;charset=utf-8'});
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = '邮箱----接码API.txt';
    link.click();
    URL.revokeObjectURL(link.href);
    notify('地址文件已下载');
  } catch (error) { notify(error.message, true); }
});

renderAccounts(savedAccounts);
checkHealth();
