import "./styles.css";

document.querySelector<HTMLElement>("#app")!.innerHTML = `
    <section class="min-h-screen bg-dashboard-background p-8 text-dashboard-foreground">
        <div class="mx-auto max-w-4xl">
            <p class="text-sm uppercase tracking-widest text-dashboard-accent">Scufris</p>
            <h1 class="mt-2 text-4xl font-semibold text-dashboard-bright">Dashboard</h1>
            <p class="mt-4 text-dashboard-muted">The dashboard skeleton is ready.</p>
        </div>
    </section>
`;
