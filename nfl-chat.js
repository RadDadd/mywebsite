(() => {
    const form = document.getElementById('chatForm');
    const input = document.getElementById('chatInput');
    const windowElement = document.getElementById('chatWindow');
    const send = document.getElementById('chatSend');
    const examples = [...document.querySelectorAll('[data-question]')];
    const history = [];
    function addMessage(text, className) {
        const element = document.createElement('div');
        element.className = `message ${className}`;
        element.textContent = text;
        windowElement.appendChild(element);
        windowElement.scrollTop = windowElement.scrollHeight;
        return element;
    }
    form.addEventListener('submit', async event => {
        event.preventDefault();
        const message = input.value.trim();
        if (!message || send.disabled) return;
        addMessage(message, 'user-message'); input.value = '';
        send.disabled = true; input.disabled = true;
        examples.forEach(button => button.disabled = true);
        const reply = addMessage('Reading the stats…', 'assistant-message');
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 60000);
        try {
            const season = Number(document.getElementById('season').value);
            const selectedWeek = document.getElementById('week').value;
            const context = { season, week: selectedWeek === 'all' ? 0 : Number(selectedWeek) };
            const messages = [...history, { role: 'user', content: message }].slice(-5);
            const response = await fetch('https://mywebsite-raddadd.vercel.app/api/chat', {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ messages, context }), signal: controller.signal
            });
            const data = await response.json();
            if (!response.ok) throw new Error(data.error || 'Could not query the stats.');
            if (typeof data.reply !== 'string' || !data.reply.trim()) throw new Error('The stats service returned an empty answer.');
            reply.textContent = data.reply;
            if (data.source) {
                const citation = document.createElement('span'); citation.className = 'chat-source';
                citation.appendChild(document.createTextNode(`Source: nflverse · ${data.source.season} · fetched ${new Date(data.source.fetchedAt).toLocaleString()} · `));
                const link = document.createElement('a'); link.textContent = 'CSV data';
                if (typeof data.source.url === 'string' && data.source.url.startsWith('https://github.com/nflverse/nflverse-data/releases/download/')) {
                    link.href = data.source.url; link.target = '_blank'; link.rel = 'noopener noreferrer'; citation.appendChild(link);
                }
                reply.appendChild(citation);
            }
            history.push({ role: 'user', content: message }, { role: 'assistant', content: data.reply.slice(0, 2200) });
            if (history.length > 4) history.splice(0, history.length - 4);
        } catch (error) {
            reply.textContent = error.name === 'AbortError' ? 'This query took too long. Please try again.' : error instanceof SyntaxError ? 'The chat service is not ready yet. Please try again after deployment.' : error.message;
        } finally {
            clearTimeout(timer); send.disabled = false; input.disabled = false;
            examples.forEach(button => button.disabled = false);
            input.focus(); windowElement.scrollTop = windowElement.scrollHeight;
        }
    });
    examples.forEach(button => button.addEventListener('click', () => { input.value = button.dataset.question; form.requestSubmit(); }));
})();
