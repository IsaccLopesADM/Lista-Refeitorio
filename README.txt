ADM Refeitório Offline - MVP v3

Correção principal:
- Removido BarcodeDetector.
- Adicionado leitor por html5-qrcode, que funciona melhor em iPhone/Safari/Chrome iOS.

Importante:
- No iPhone, precisa estar publicado em HTTPS, como GitHub Pages.
- Ao abrir câmera, aceite a permissão.
- Se estiver em modo privado/anônimo, evite; alguns recursos podem falhar.
- Se atualizar do GitHub e continuar antigo, limpe cache ou abra com ?v=3 no final da URL.

Passos:
1) Substitua os arquivos antigos no seu repositório pelos arquivos desta pasta.
2) Confira o config.js com sua URL e chave pública do Supabase.
3) Suba para o GitHub.
4) No iPhone, abra a URL do GitHub Pages.
5) Faça login.
6) Clique em Abrir câmera.
7) Aponte para o QR.

Observação:
- A biblioteca html5-qrcode vem de CDN:
  https://unpkg.com/html5-qrcode
- Portanto, no primeiro carregamento precisa de internet.
- Depois o app continua com registros offline, mas a biblioteca precisa carregar ao menos uma vez.
