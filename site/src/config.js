// =============================================================================
// DADOS DA LOJA — o site inteiro usa estas informações.
// Campo vazio ('') = a informação não aparece no site.
// =============================================================================
export const BUSINESS = {
  name: 'Car King Auto Sales',
  // Endereço completo do site depois de comprar um domínio (ex.: 'https://carkingautosales.com').
  // Enquanto não tiver domínio, deixe o endereço do GitHub Pages.
  siteUrl: 'https://brayanreis32.github.io/Car-king',

  phone: '',          // ex.: '(407) 555-0100'
  textPhone: '',      // celular para SMS/WhatsApp; vazio = usa o phone
  email: '',          // ex.: 'sales@carkingautosales.com'

  street: '',         // ex.: '1234 W Colonial Dr'
  city: '',           // ex.: 'Orlando'
  state: '',          // ex.: 'FL'
  zip: '',            // ex.: '32804'
  byAppointment: false, // true = "Visitas com hora marcada" (sem loja aberta ao público)

  // Horário de atendimento. Deixe a lista vazia [] para não mostrar.
  hours: [
    // ['Monday – Friday', '9:00 AM – 6:00 PM'],
    // ['Saturday', '10:00 AM – 4:00 PM'],
    // ['Sunday', 'Closed'],
  ],

  languages: ['English', 'Português', 'Español'],

  instagram: '',      // link completo do perfil
  facebook: '',
}

// Conexão com o Supabase (a mesma do sistema; chave pública)
export { SUPABASE_URL, SUPABASE_ANON_KEY } from '../../app/src/config.js'
