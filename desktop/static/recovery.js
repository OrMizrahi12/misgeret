const params = new URLSearchParams(window.location.search);
const code = params.get('code');
if (code) document.querySelector('#error-code').textContent = `קוד: ${code}`;

for (const [id, action] of [['retry', 'retry'], ['logs', 'open-logs'], ['quit', 'quit']]) {
  document.querySelector(`#${id}`).addEventListener('click', () => {
    void window.misgeret.recoveryAction(action);
  });
}
