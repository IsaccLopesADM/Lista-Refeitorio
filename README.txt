ADM Refeitório Offline - MVP v1

1) No Supabase, crie os usuários em Authentication > Users:
   - um admin
   - um usuário refeitorio

2) Depois rode no SQL Editor, trocando os e-mails:

insert into public.usuarios_app (id, nome, email, perfil, ativo)
select id, 'Isacc Admin', email, 'admin', true
from auth.users
where email = 'SEU_EMAIL_ADMIN_AQUI';

insert into public.usuarios_app (id, nome, email, perfil, ativo)
select id, 'Refeitório', email, 'refeitorio', true
from auth.users
where email = 'EMAIL_REFEITORIO_AQUI';

3) Edite config.js:
   - SUPABASE_URL
   - SUPABASE_ANON_KEY

4) Para testar local:
   - Abra a pasta no VS Code
   - Rode um servidor local, exemplo:
     python -m http.server 5500
   - Acesse:
     http://localhost:5500

5) Para usar câmera no tablet/celular:
   - Publique em HTTPS, exemplo GitHub Pages.
   - Em localhost também funciona para teste.

6) Primeiro uso:
   - Faça login
   - Clique em "Baixar base do Supabase"
   - Vá em "Leitura"
   - Leia o QR
   - Se o QR não estiver vinculado, informe apenas a matrícula
   - O sistema vincula QR + matrícula e registra a refeição

Observações:
- O app usa IndexedDB para salvar base e registros offline.
- O som é gerado pelo próprio navegador, sem arquivo de áudio.
- O leitor por câmera usa BarcodeDetector quando o navegador suporta.
- Se o navegador não suportar, use entrada manual ou leitor USB/Bluetooth.
- Nunca coloque a service_role key no config.js.
