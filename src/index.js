const {
  BaseKonnector,
  requestFactory,
  scrape,
  saveBills,
  log,
  utils,
  errors
} = require('cozy-konnector-libs')
const request = requestFactory({
  // The debug mode shows all the details about HTTP requests and responses. Very useful for
  // debugging but very verbose. This is why it is set to false by default
  debug: false,
  // Activates [cheerio](https://cheerio.js.org/) parsing on each page
  cheerio: true,
  // If cheerio is activated do not forget to deactivate json parsing (which is activated by
  // default in cozy-konnector-libs)
  json: false,
  // This allows request-promise to keep cookies between requests
  jar: true
})
const cheerio = require('cheerio')
const PassThrough = require('stream').PassThrough

const VENDOR = 'dauchez'
const baseUrl = 'https://extranet.dauchez.fr'

module.exports = new BaseKonnector(start)

// The start function is run by the BaseKonnector instance only when it got all the account
// information (fields). When you run this connector yourself in "standalone" mode or "dev" mode,
// the account information come from ./konnector-dev-config.json file
async function start(fields) {
  log('info', 'Authenticating ...')
  await authenticate(fields.username, fields.password)
  log('info', 'Successfully logged in')
  log('info', 'Fetching the list of documents')
  const docList = await getDocumentsList()
  log('info', 'Parsing list of documents')
  const documents = await parseDocuments(docList)
  log('info', 'Saving data to Cozy')
  await saveBills(documents, fields, {
    // This is a bank identifier which will be used to link bills to bank operations. These
    // identifiers should be at least a word found in the title of a bank operation related to this
    // bill. It is not case sensitive.
    identifiers: ['dauchez']
  })
}

// HTML form uses a JS wrapper, meaning that signin function cannot be used.
// Use a simple POST request instead.
async function authenticate(username, password) {
  const loginResult = await request(`${baseUrl}/Login`, {
    method: 'POST',
    headers: {
      // Why do we need this header? No idea ¯\_(ツ)_/¯, but it doesn't work without it
      'X-Requested-With': 'XMLHttpRequest'
    },
    form: {
      identifiant: username,
      pwd: password,
      'g-recaptcha-response': '',
      hid_css: '',
      isIframe: 0
    },
    json: true,
    // Activate full response to get status code
    resolveWithFullResponse: true
  })

  // First, check if status code is correct
  if (loginResult.statusCode != 200) {
    log('error', 'Failed to login, status code = ' + loginResult.statusCode)
    throw new Error(errors.LOGIN_FAILED)
  }

  // Then check the response
  const jsonResponse = loginResult.body._root.children[0]
  if (jsonResponse.response === true && jsonResponse.flag_login === true) {
    // Follow redirection if any is present
    if (jsonResponse.redirect) {
      await request(`${baseUrl}${jsonResponse.redirect}`)
    }
    return true
  }

  log('error', 'Failed to login, response: "' + jsonResponse.message + '"')
  throw new Error(errors.LOGIN_FAILED)
}

async function getDocumentsList() {
  // First get the account page
  await request(`${baseUrl}/Extranet/Compte`)
  // Then get the situation
  await request(`${baseUrl}/Extranet/Compte/situation`)
  // Then load the "encart" (whatever it is)
  await request(`${baseUrl}/Encart/load`, {
    method: 'POST',
    headers: {
      'X-Requested-With': 'XMLHttpRequest'
    }
  })
  // And finally we can get the list of operations (only the rent bills)
  const docList = await request(`${baseUrl}/Extranet/Compte/listSituation`, {
    method: 'POST',
    headers: {
      'X-Requested-With': 'XMLHttpRequest'
    },
    form: {
      sortCompte: '',
      titleCompte: 'Situation',
      limitCompte: 0,
      nom: '',
      debit: 1,
      id_libelle_code_collectif: 22,
      montant_min: '',
      montant_max: '',
      date_debut: '',
      date_fin: '',
      'id_type_collectif[]': 7
    },
    json: true,
    // Activate full response to get status code
    resolveWithFullResponse: true
  })
  if (docList.statusCode != 200) {
    log('error', 'Failed to get documents, status code = ' + docList.statusCode)
    throw new Error(errors.NOT_EXISTING_DIRECTORY)
  }
  if (docList.body._root.children[0].response != true) {
    log(
      'error',
      'Failed to get documents, message: "' +
        docList.body._root.children[0].message +
        '"'
    )
    throw new Error(errors.NOT_EXISTING_DIRECTORY)
  }
  // The content is HTML, convert it to a cheerio object
  return cheerio.load(docList.body._root.children[0].returnArray.contenu)
}

// The goal of this function is to parse a HTML page wrapped by a cheerio instance
// and return an array of JS objects which will be saved to the cozy by saveBills
// (https://github.com/konnectors/libs/blob/master/packages/cozy-konnector-libs/docs/api.md#savebills)
async function parseDocuments(docList) {
  // You can find documentation about the scrape function here:
  // https://github.com/konnectors/libs/blob/master/packages/cozy-konnector-libs/docs/api.md#scrape
  const docs = scrape(
    docList,
    {
      date: {
        sel: 'td:nth-child(1)',
        parse: normalizeDate
      },
      title: {
        sel: 'td:nth-child(3)'
      },
      amount: {
        sel: 'td:nth-child(4)',
        parse: normalizePrice
      },
      fileUrl: {
        sel: 'td:nth-child(6)>span>a',
        attr: 'href'
      }
    },
    'table>tbody>tr:not(:first-child):not(:last-child)'
  )

  // Now that we have the possible files, download them
  let finalDocs = []
  for (let doc of docs) {
    if (doc.fileUrl) {
      const filename = `${utils.formatDate(
        doc.date
      )}_${VENDOR}_${doc.amount.toFixed(2)}€${
        doc.vendorRef ? '_' + doc.vendorRef : ''
      }.pdf`
      const filestream = await request(`${baseUrl}${doc.fileUrl}`, {
        cheerio: false,
        json: false
      }).pipe(new PassThrough())

      finalDocs.push({
        ...doc,
        filename,
        filestream,
        currency: '€',
        vendor: VENDOR,
        metadata: {
          // It can be interesting to add the date of import. This is not mandatory but may be
          // useful for debugging or data migration
          importDate: new Date(),
          // Document version, useful for migration after change of document structure
          version: 1
        }
      })
    }
  }
  return finalDocs
}

// Convert a date string to a date
function normalizeDate(date) {
  // String format: dd/mm/yyyy
  return new Date(
    date.slice(6, 10) + '-' + date.slice(3, 5) + '-' + date.slice(0, 2) + 'Z'
  )
}

// Convert a price string to a float
function normalizePrice(price) {
  // Replace ',' by '.' and remove extra white spaces for parseFloat
  return parseFloat(
    price
      .replace(',', '.')
      .replace(/\s/g, '')
      .trim()
  )
}
