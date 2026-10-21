'use strict';

const input = document.getElementById('spec');
const error = document.getElementById('error');
const submit = document.getElementById('submit');
const cancel = document.getElementById('cancel');

function setBusy(busy) {
  input.disabled = busy;
  submit.disabled = busy;
  cancel.disabled = busy;
}

async function onSubmit() {
  error.textContent = '';
  const value = input.value.trim();
  if (!value) {
    error.textContent = '请输入插件包名或安装地址。';
    input.focus();
    return;
  }
  setBusy(true);
  try {
    const result = await window.dshInstaller.submit(value);
    if (result && result.ok === false) {
      error.textContent = result.error || '安装参数无效。';
      setBusy(false);
      input.focus();
    }
  } catch (failure) {
    error.textContent = String(failure?.message || failure);
    setBusy(false);
  }
}

submit.addEventListener('click', () => { void onSubmit(); });
cancel.addEventListener('click', () => window.dshInstaller.cancel());
input.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') {
    event.preventDefault();
    void onSubmit();
  } else if (event.key === 'Escape') {
    window.dshInstaller.cancel();
  }
});
